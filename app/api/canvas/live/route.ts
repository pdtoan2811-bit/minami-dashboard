// Live ingest: an audio file → transcript → canvas actions, streamed as SSE.
//
//   GET /api/canvas/live?minutes=1|2|5|10|0&mode=live   (0 = whole file)
//
// Two phases, deliberately overlapped. Transcription runs several chunks CONCURRENTLY so the surface
// feels live; action derivation runs strictly IN ORDER because each call needs the board as it stood
// after the previous one. So chunk 4 may be transcribed while chunk 1 is still being judged, but
// chunk 1's cards always land first.
//
// The run emits a `report` event at the end carrying latency, per-leg cost and accuracy proxies. It
// was built to compare A/B arms; the arms are gone (mimo lost — see lib/canvas-modes.ts) but the
// scorecard stays, because it is the only thing that turns a config change into a number. Chunk size
// is the knob still worth sweeping, and CANVAS_CHUNK_SECONDS moves it without a patch.

import { NextRequest } from "next/server";
import { planChunks, sliceChunk } from "@/lib/audio";
import { resolveSource } from "@/lib/canvas-audio";
import {
  addSpend, deriveActions, findRelations, glossaryFrom, noSpend, refineBoard, transcribe,
  type RawAction,
} from "@/lib/canvas-llm";
import { resolveMode } from "@/lib/canvas-modes";
import type { GNode, Graph, NodeKind, NodeState } from "@/lib/canvas-graph";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const CARD_KINDS = new Set<NodeKind>([
  "decision", "requirement", "question", "risk", "milestone", "action", "quote", "aside", "note",
]);
const STATES = new Set<NodeState>(["proposed", "agreed", "done", "blocked", "open"]);

/** Bounded parallelism. Removing this cap — firing every transcription AND every derivation at once
 *  — pushed time-to-first-transcript from 8s to 29s and made two chunks in three fail outright:
 *  six simultaneous calls throttle each other and everything arrives late together. Concurrency is
 *  only free up to the point the provider starts pushing back. */
function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try { return await fn(); }
    finally { active--; queue.shift()?.(); }
  };
}

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams;
  const minutes = Number(q.get("minutes") ?? "1");
  const mode = resolveMode(q.get("mode"));
  // Playback speed, as a multiple of real time. A real ASR arm judges 15s of audio in about two
  // seconds, so a 3-minute file finishes in well under thirty and the board simply APPEARS — you
  // never see it built, which is the entire thing this surface is meant to show. Pacing gates only
  // the EMISSION of events; the pipeline still runs flat out and the scorecard still reports its
  // true latency (see the pre-gate stamps below). `max` restores the raw firehose.
  // How audio is HANDED to the pipeline, as opposed to how results are released.
  //   parallel — slice the whole file up front and run `concurrency` chunks at once (fastest; what
  //              you want when you are timing the pipeline)
  //   serial   — hand over one chunk at a time, and not before the wall clock reaches the moment
  //              that audio would have been spoken. This is the honest simulation of a live call:
  //              on a real meeting you cannot transcribe minute 4 while minute 1 is still being
  //              said, so parallel ingest flatters every latency number it produces.
  // Which recording. Named rather than pathed, so a URL can't point the server at an arbitrary file.
  const source = resolveSource(q.get("source"));
  const AUDIO = source.file;
  const feed = q.get("feed") === "serial" ? "serial" : "parallel";
  const paceRaw = q.get("pace") ?? "1";
  const pace = paceRaw === "max" ? Infinity : Math.max(0.25, Number(paceRaw) || 1);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* client gone */ }
      };

      // ── canvas state, owned entirely by the server ────────────────────────────────────────
      // The model never writes an id and never references one. It names a topic as a STRING; the
      // server maps names to clusters, deduping case-insensitively. That is what lets every chunk be
      // judged independently — with ref-based ids each chunk had to wait for the previous chunk's
      // board, which serialised 10-30s calls into minutes of dead time.
      // Hoisted above the helpers so paceGate can close over it; everything between here and where
      // it used to sit is function definitions, so the run still starts timing at the run's start.
      const t0 = Date.now();

      // Hold an event until the wall clock reaches the audio position it belongs to. Never rushes
      // the pipeline — if the pipeline is the slower of the two, this returns immediately.
      const paceGate = async (audioSec: number) => {
        if (!Number.isFinite(pace)) return;
        const due = (audioSec / pace) * 1000;
        const wait = due - (Date.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
      };

      // ── stage trace ───────────────────────────────────────────────────────────────────────
      // One line per chunk per stage, with the wall clock and how far BEHIND the audio that stage
      // is running. Lag is the number that matters: a stage can be fast in absolute terms and still
      // lose a live call, because the audio keeps arriving whether you kept up or not. Without this
      // "feels laggy" is unfalsifiable — you cannot tell slicing from ASR from judging from a slow
      // provider endpoint, which is exactly how three rounds of speed work turned into guesswork.
      const trace = (index: number, stage: string, note: string, dueSec?: number) => {
        const atMs = Date.now() - t0;
        const dueMs = dueSec !== undefined && Number.isFinite(pace) ? (dueSec / pace) * 1000 : undefined;
        send("debug", {
          index, stage, atMs, note,
          lagMs: dueMs === undefined ? undefined : Math.round(atMs - dueMs),
        });
      };

      const nodes: GNode[] = [{ id: "root", kind: "topic", label: "Meeting" }];
      const topicByName = new Map<string, string>();
      const edges: Graph["edges"] = [];
      const cardByLabel = new Map<string, string>();
      let seq = 0;
      const transcriptLines: string[] = [];
      const seenLabels = new Set<string>();

      const topicId = (name: string) => {
        const key = name.trim().toLowerCase().slice(0, 40);
        const hit = topicByName.get(key);
        if (hit) return hit;

        // Fuzzy merge before creating. Chunks are judged in parallel, so each starts with whatever
        // topics happened to exist and invents its own name for the same subject — one run produced
        // "OpenAI Lumen", "OpenAI Sore" and "OpenAI Models" as three separate clusters for one
        // subject. Exact-name dedupe can't catch that. If a candidate shares most of its meaningful
        // words with an existing topic, it IS that topic.
        const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
        const mine = words(key);
        if (mine.size) {
          for (const [existing, id] of topicByName) {
            const theirs = words(existing);
            const shared = [...mine].filter((w) => theirs.has(w)).length;
            if (shared / Math.min(mine.size, theirs.size) >= 0.5) {
              topicByName.set(key, id);   // remember the alias so we only pay this once
              return id;
            }
          }
        }
        const id = `t${++seq}`;
        topicByName.set(key, id);
        nodes.push({ id, kind: "topic", label: name.trim().slice(0, 40), parent: "root" });
        return id;
      };

      /** Fold `target` into `into`: reattach every edge, drop the duplicate node. Returns whether
       *  anything actually happened. */
      const mergeCards = (targetLabel: string, intoLabel: string) => {
        const from = cardByLabel.get(targetLabel.trim().toLowerCase());
        const to = cardByLabel.get(intoLabel.trim().toLowerCase());
        if (!from || !to || from === to) return false;
        const i = nodes.findIndex((n) => n.id === from);
        if (i < 0) return false;
        // Carry the loser's detail over if the winner has none — merging shouldn't lose text.
        const winner = nodes.find((n) => n.id === to);
        if (winner && !winner.detail && nodes[i].detail) winner.detail = nodes[i].detail;
        // Keep the absorbed label. Two cards merging means the same point was made twice — worth
        // seeing on the board, not just in a log line nobody reads.
        if (winner) {
          winner.mergedFrom = [
            ...(winner.mergedFrom ?? []),
            nodes[i].label,
            ...(nodes[i].mergedFrom ?? []),
          ].slice(0, 4);
        }
        nodes.splice(i, 1);
        for (const e of edges) {
          if (e.from === from) e.from = to;
          if (e.to === from) e.to = to;
        }
        // Self-edges and duplicates can both appear as a result of the rewrite above.
        for (let j = edges.length - 1; j >= 0; j--) {
          const e = edges[j];
          if (e.from === e.to || edges.some((o, k) => k < j && o.from === e.from && o.to === e.to)) {
            edges.splice(j, 1);
          }
        }
        cardByLabel.set(targetLabel.trim().toLowerCase(), to);
        return true;
      };

      /** Rewrite an existing card in place. The id is kept deliberately: the canvas animates a card
       *  it already knows about, so a revision reads as the card CHANGING rather than one vanishing
       *  and a similar one appearing somewhere else. */
      const reviseCard = (a: RawAction) => {
        const id = cardByLabel.get((a.target ?? "").trim().toLowerCase());
        const node = id ? nodes.find((n) => n.id === id) : undefined;
        if (!node) return false;
        if (a.label) {
          const next = a.label.slice(0, 90);
          cardByLabel.delete(node.label.toLowerCase());
          seenLabels.delete(node.label.trim().toLowerCase());
          node.label = next;
          cardByLabel.set(next.toLowerCase(), node.id);
          seenLabels.add(next.trim().toLowerCase());
        }
        if (a.detail) node.detail = a.detail.slice(0, 160);
        if (STATES.has(a.state as NodeState)) node.state = a.state as NodeState;
        if (CARD_KINDS.has(a.kind as NodeKind)) node.kind = a.kind as NodeKind;
        return true;
      };

      /** The tidy pass works in ids, not labels — it is reading the board it was handed, so there is
       *  no name to resolve and no chance of it inventing one. */
      const mergeById = (fromId: string, intoId: string) => {
        const f = nodes.find((n) => n.id === fromId);
        const t = nodes.find((n) => n.id === intoId);
        if (!f || !t || f === t) return false;
        return mergeCards(f.label, t.label);
      };
      const reviseById = (r: { id: string; label?: string; detail?: string }) => {
        const node = nodes.find((n) => n.id === r.id);
        if (!node) return false;
        return reviseCard({ op: "revise", target: node.label, label: r.label, detail: r.detail });
      };

      const apply = (a: RawAction, lines: string[]): GNode | null => {
        // Board edits are not new cards and must not be counted or grounded as if they were: there
        // is no source quote for "these two were the same thing".
        if (a.op === "merge") { mergeCards(a.target ?? "", a.into ?? ""); return null; }
        if (a.op === "revise") { reviseCard(a); return null; }
        if (!a.label) return null;
        const kind = (CARD_KINDS.has(a.kind as NodeKind) ? a.kind : "note") as NodeKind;
        if (!quoteIsGrounded(a.source ?? "", lines)) return null;

        // Chunks overlap by 6s, so the same sentence can legitimately be judged twice. Dedupe on the
        // label rather than trusting the model not to repeat itself.
        const key = a.label.trim().toLowerCase();
        if (seenLabels.has(key)) return null;
        seenLabels.add(key);

        // `under` names a card; `topic` names a cluster. A card wins when it resolves, because the
        // model only reaches for it when the new point genuinely hangs off a specific earlier one —
        // and an unresolvable name falls back to the topic rather than being guessed at.
        const underId = a.under ? cardByLabel.get(a.under.trim().toLowerCase()) : undefined;
        const node: GNode = {
          id: `c${++seq}`,
          kind,
          parent: underId ?? topicId(a.topic || "General"),
          label: a.label.slice(0, 90),
          detail: a.detail?.slice(0, 160),
          state: STATES.has(a.state as NodeState) ? (a.state as NodeState) : undefined,
        };
        nodes.push(node);
        cardByLabel.set(node.label.toLowerCase(), node.id);

        // Relationship, if it names a card we actually have. Resolved by label because the model
        // never sees ids; unresolvable ones are dropped rather than guessed, which is the same rule
        // that stops it referencing nodes that don't exist.
        if (a.relatesTo && a.relation) {
          const target = cardByLabel.get(a.relatesTo.trim().toLowerCase());
          if (target && target !== node.id) {
            edges.push({ from: node.id, to: target, kind: a.relation as never });
          }
        }
        return node;
      };

      try {
        const { chunks, want } = await planChunks(AUDIO, minutes, mode.chunkSeconds, mode.overlapSeconds);
        send("meta", {
          chunks: chunks.length,
          seconds: Math.round(want),
          mode: mode.id,
          label: mode.label,
          blurb: mode.blurb,
          chunkSeconds: mode.chunkSeconds,
        });
        // Parallel chunks can't see each other's topics, so left alone they each invent their own
        // name for the same subject — 6 clusters for 3 minutes of one conversation. Handing every
        // chunk the names created SO FAR pulls them together without restoring the sequential
        // dependency: a chunk uses whatever exists when it starts, and the name-keyed dedupe below
        // merges the rest.
        const topicNames = () =>
          nodes.filter((n) => n.kind === "topic" && n.id !== "root").map((n) => n.label);

        // Transcribe AND derive every chunk concurrently; emit strictly in order. Measured before
        // this change: transcription was already fully hidden by concurrency (0.0s wait after the
        // first chunk) while derivation ran 10-30s each, in sequence. Derivation was the whole cost.
        // DECOUPLED emit. Transcript goes out the moment it exists; cards follow when judged. They
        // were bundled into one event, so nothing at all appeared for 41s — the canvas looked dead
        // for the entire time the model was thinking. Transcription lands in ~8s, so showing it
        // immediately turns a 40s blank stare into 8s to first content.
        const texts = new Map<number, Promise<string[]>>();
        const cards = new Map<number, Promise<RawAction[]>>();
        // Separate pools: transcription and derivation compete for the same provider, but starving
        // transcription is what makes the canvas look dead, so it gets its own budget.
        // Serial feed means exactly one chunk in flight — the limiter enforces it, the gate below
        // decides when that one slot opens.
        const runAudio = limiter(feed === "serial" ? 1 : mode.concurrency);
        const runJudge = limiter(mode.concurrency);

        // ── what the arms are judged on ───────────────────────────────────────────────────────
        // Billed separately per leg, because "which leg is the bottleneck" is the question that
        // decides what to fix next, and one total cannot answer it.
        const audioSpend = noSpend();
        const judgeSpend = noSpend();
        const relSpend = noSpend();
        let ttfTranscriptMs = 0;
        let ttfCardMs = 0;
        let speakers = 0;
        let sttProfile = "";
        let emptyChunks = 0;
        let rawCards = 0;

        // Everything transcribed SO FAR, in whatever order the calls happen to land. Feeds keyterms
        // upstream on the stt arm, which is where a proper-noun fix belongs: a name the ASR gets
        // right needs no spelling patch downstream. The chat arm ignores it.
        const heard: string[] = [];

        for (const c of chunks) {
          const text = runAudio(async () => {
            // Hold the slot until this audio "has been spoken". Inside the limiter, so chunk i+1
            // isn't merely emitted late — it hasn't been sliced, sent or billed yet either.
            if (feed === "serial") await paceGate(c.start);
            trace(c.index, "start", `${fmt(c.start)}–${fmt(c.start + c.seconds)} (${c.seconds}s)`, c.start);
            const sliceT = Date.now();
            const buf = await sliceChunk(AUDIO, c.start, c.seconds);
            trace(c.index, "slice", `${Math.round(buf.length / 1024)} KB in ${Date.now() - sliceT}ms`);
            const asrT = Date.now();
            const r = await transcribe(mode.transcribe, buf, glossaryFrom(heard), audioSpend);
            trace(c.index, "asr", `${r.lines.length} lines, ${r.lines.join(" ").length} chars in ${Date.now() - asrT}ms`);
            if (r.speakers > speakers) speakers = r.speakers;
            sttProfile = r.profile;
            heard.push(...r.lines);
            return r.lines;
          })
            // Swallowing this error is what made three rounds of speed work guesswork: every failure
            // looked identical to "the model found nothing". Surface it.
            .catch((e) => { send("warn", { stage: "transcribe", index: c.index, error: String(e).slice(0, 200) }); return [] as string[]; });
          texts.set(c.index, text);
          // On a SERIAL feed judging happens inside the emit loop instead, because the whole point
          // of that feed is that chunk N is judged against the board chunks 0..N-1 actually built.
          // Prefetching it here would judge every chunk against an empty board, which is the
          // stateless behaviour the parallel feed wants and the serial feed exists to avoid.
          if (feed !== "serial") cards.set(
            c.index,
            text.then((lines) =>
              lines.length
                ? runJudge(async () => {
                    const jt = Date.now();
                    const out = await deriveActions(
                      topicNames(),
                      lines.join("\n"),
                      glossaryFrom(lines),
                      nodes.filter((n) => n.kind !== "topic").map((n) => n.label),
                      { cfg: mode.derive, spend: judgeSpend },
                    );
                    trace(c.index, "judge", `${out.length} raw cards in ${Date.now() - jt}ms`);
                    return out;
                  })
                : ([] as RawAction[]),
            ).catch((e) => { send("warn", { stage: "derive", index: c.index, error: String(e).slice(0, 200) }); return [] as RawAction[]; }),
          );
        }

        // ── emitting ──────────────────────────────────────────────────────────────────────────
        // Two shapes, because the feeds want opposite things.
        const emitTranscript = async (c: { index: number; start: number; seconds: number }, lns: string[]) => {
          transcriptLines.push(...lns);
          // Time to FIRST content is the number that decides whether the surface feels live; a
          // total that averages it away hides the 41s blank stare this pipeline used to open with.
          // Stamp BEFORE the gate: measuring after would fold the playback delay into the latency
          // number and make a paced run look like a slow pipeline. And on a serial feed the clock
          // that matters is "how long after these words were spoken did they appear".
          const availableMs = feed === "serial" && Number.isFinite(pace) ? (c.start / pace) * 1000 : 0;
          const readyMs = Math.max(0, Date.now() - t0 - availableMs);
          if (!ttfTranscriptMs) ttfTranscriptMs = readyMs;
          await paceGate(c.start);
          trace(c.index, "transcript", `${lns.length} lines on screen`, c.start);
          send("transcript", { index: c.index, at: fmt(c.start), lines: lns, ms: readyMs });
        };

        const emitCards = async (
          c: { index: number; start: number; seconds: number }, lns: string[], raw: RawAction[],
        ) => {
          rawCards += raw.length;
          const applied: GNode[] = [];
          // Two passes: create everything first, then bind relationships. A card often points at
          // another card in the SAME reply, and single-pass binding silently dropped every one of
          // those because the target didn't exist yet.
          for (const a of raw) { const n = apply(a, lns); if (n) applied.push(n); }
          for (const a of raw) {
            if (!a.relatesTo || !a.relation || !a.label) continue;
            const from = cardByLabel.get(a.label.trim().toLowerCase());
            const to = cardByLabel.get(a.relatesTo.trim().toLowerCase());
            if (from && to && from !== to && !edges.some((e) => e.from === from && e.to === to)) {
              edges.push({ from, to, kind: a.relation as never });
            }
          }
          const availableCardMs = feed === "serial" && Number.isFinite(pace) ? (c.start / pace) * 1000 : 0;
          const cardReadyMs = Math.max(0, Date.now() - t0 - availableCardMs);
          if (!ttfCardMs && applied.length) ttfCardMs = cardReadyMs;
          // End of the chunk, not its start: the cards summarise the whole window, so releasing them
          // at the window's start would put a conclusion on screen before its evidence.
          await paceGate(c.start + c.seconds);
          const revised = raw.filter((a) => a.op === "revise" || a.op === "merge").length;
          trace(
            c.index, "cards",
            `${applied.length} kept, ${revised} revised/merged, ${raw.length - applied.length - revised} dropped`,
            c.start + c.seconds,
          );
          send("graph", {
            index: c.index,
            // Marks a CHUNK completing, as opposed to a tidy or relate pass. The client counts
            // progress and drives its listening/thinking indicator off this; counting every graph
            // event made both overshoot, because a mid-meeting tidy is not another minute of audio.
            chunkDone: true,
            graph: {
              rev: c.index + 1, title: "Live transcript", subtitle: `${mode.label} · ${source.label}`, status: "live",
              focus: applied[applied.length - 1]?.id,
              nodes, edges,
            } satisfies Graph,
            actions: applied.map((n) => ({ op: "card", kind: n.kind, label: n.label })),
            dropped: raw.length - applied.length - revised,
            proposedRels: raw.filter((a) => a.relatesTo).length,
            timing: { sinceStartMs: cardReadyMs },
          });
        };

        let tidyInFlight = false;
        if (feed === "serial") {
          // ONE interleaved loop. The previous shape drained every transcript before emitting any
          // card, so chunk 0's cards — ready at 5.3s — sat unshown until 44.9s, waiting on the LAST
          // chunk's transcript. The board arrived all at once at the end, which is the opposite of
          // a live feed however carefully the audio was paced.
          //
          // Judging also moves in here, and that is the substantive difference: chunk N is judged
          // against the board chunks 0..N-1 actually built, so it can correct a mishearing, sharpen
          // a half-formed thought, or merge a duplicate as later context arrives — the things a
          // person does to a whiteboard, and none of which a stateless chunk can do.
          for (const c of chunks) {
            const lns = await texts.get(c.index)!;
            if (!lns.length) { emptyChunks++; continue; }
            await emitTranscript(c, lns);
            const jt = Date.now();
            const raw = await runJudge(() => deriveActions(
              topicNames(),
              lns.join("\n"),
              glossaryFrom(lns),
              nodes.filter((n) => n.kind !== "topic").map((n) => n.label),
              { cfg: mode.derive, spend: judgeSpend, revise: true },
            )).catch((e) => {
              send("warn", { stage: "derive", index: c.index, error: String(e).slice(0, 200) });
              return [] as RawAction[];
            });
            trace(c.index, "judge", `${raw.length} raw actions in ${Date.now() - jt}ms`);
            await emitCards(c, lns, raw);

            // Tidy every fourth chunk — roughly once a minute at 15s chunks. Often enough that the
            // board visibly self-corrects while you watch, rare enough that it costs one extra call
            // a minute and always lands inside the slack a keeping-up pipeline already has.
            const cardsNow = nodes.filter((n) => n.kind !== "topic");
            // NOT awaited. Blocking the chunk loop on it cost 62s and then 220s on the slow judge and
            // pushed the feed 104s behind the audio — a tidier board that arrives two minutes late is
            // worse than an untidy one that keeps up. It runs alongside the next chunks and applies
            // whenever it lands; ids stay valid, and a card that vanished meanwhile is simply skipped.
            // One at a time, so a slow pass can't stack up behind itself.
            if ((c.index + 1) % 4 === 0 && cardsNow.length >= 3 && !tidyInFlight) {
              tidyInFlight = true;
              const rt = Date.now();
              void refineBoard(
                cardsNow.map((n) => ({ id: n.id, label: n.label, detail: n.detail })),
                transcriptLines.slice(-24).join("\n"),
                { cfg: { ...mode.derive, model: mode.derive.tidyModel }, spend: judgeSpend },
              )
                .catch(() => ({ revise: [], merge: [], nest: [] }))
                .then((tidy) => {
                  let changed = 0;
                  for (const r of tidy.revise) if (reviseById(r)) changed++;
                  for (const m of tidy.merge) if (mergeById(m.from, m.into)) changed++;
                  // Re-parenting, with a cycle guard: walking up from the proposed parent must never
                  // reach the node being moved, or the tree stops being a tree and the layout
                  // recurses forever.
                  for (const nst of tidy.nest) {
                    const node = nodes.find((n) => n.id === nst.id);
                    const target = nodes.find((n) => n.id === nst.under);
                    if (!node || !target) continue;
                    let cur: GNode | undefined = target;
                    let cyclic = false;
                    for (let i = 0; cur && i < 40; i++) {
                      if (cur.id === node.id) { cyclic = true; break; }
                      cur = nodes.find((n) => n.id === cur!.parent);
                    }
                    if (cyclic || node.parent === target.id) continue;
                    node.parent = target.id;
                    changed++;
                  }
                  trace(
                    c.index, "tidy",
                    `${tidy.revise.length} revise, ${tidy.merge.length} merge, ${tidy.nest.length} nest → ${changed} applied in ${Date.now() - rt}ms`,
                  );
                  if (changed) {
                    send("graph", {
                      index: c.index,
                      graph: {
                        rev: c.index + 1, title: "Live transcript", subtitle: `${mode.label} · ${source.label}`, status: "live",
                        nodes, edges,
                      } satisfies Graph,
                      actions: [
                        ...tidy.revise.map((r) => ({ op: "revise", kind: "revise", label: r.label ?? r.id })),
                        ...tidy.merge.map((m) => ({ op: "merge", kind: "merge", label: `${m.from} → ${m.into}` })),
                      ],
                      dropped: 0,
                      timing: { sinceStartMs: Date.now() - t0 },
                    });
                  }
                })
                .finally(() => { tidyInFlight = false; });
            }
          }
        } else {
          // Two passes over the same promises: transcripts first (fast), then cards (slow). Both
          // stay in chunk order, so the panel reads chronologically even though everything ran at
          // once — and a transcript is never held back behind some other chunk's judging.
          for (const c of chunks) {
            const lns = await texts.get(c.index)!;
            if (!lns.length) { emptyChunks++; continue; }
            await emitTranscript(c, lns);
          }
          for (const c of chunks) {
            const lns = await texts.get(c.index)!;
            const raw = await cards.get(c.index)!;
            if (!lns.length) continue;
            await emitCards(c, lns, raw);
          }
        }
        // Relationships, once, over the finished board — the only point at which cross-chunk links
        // are visible at all.
        trace(-1, "relate", "whole-board pass starting");
        const relT = Date.now();
        const { links, reactions } = await findRelations(
          nodes.filter((n) => n.kind !== "topic").map((n) => ({ id: n.id, kind: n.kind, label: n.label })),
          {
            cfg: { ...mode.derive, model: mode.derive.relateModel },
            spend: relSpend,
            transcript: transcriptLines.join("\n"),
          },
        );
        // Reactions land on the cards themselves, so they survive as part of the board rather than
        // flashing past as an event.
        for (const r of reactions) {
          const node = nodes.find((n) => n.id === r.id);
          if (node) node.reactions = [...(node.reactions ?? []), { emoji: r.emoji, count: 1 }];
        }
        trace(-1, "relate", `${links.length} links, ${reactions.length} reactions in ${Date.now() - relT}ms`);
        for (const l of links) {
          if (!edges.some((e) => e.from === l.from && e.to === l.to)) {
            edges.push({ from: l.from, to: l.to, kind: l.kind as never });
          }
        }
        if (links.length || reactions.length) {
          send("graph", {
            graph: { rev: 9999, title: "Live transcript", subtitle: `${mode.label} · ${source.label}`, status: "live", nodes, edges } satisfies Graph,
            actions: [
              ...links.map((l) => ({ op: "edge", kind: l.kind, label: `${l.from} → ${l.to}` })),
              ...reactions.map((r: { id: string; emoji: string }) => ({
                op: "react", kind: r.emoji, label: nodes.find((n) => n.id === r.id)?.label ?? r.id,
              })),
            ],
            dropped: 0,
            timing: { sinceStartMs: 0 },
          });
        }

        // ── the scorecard ─────────────────────────────────────────────────────────────────────
        // Cost is reported per audio-hour as well as absolute, because the arms use different chunk
        // lengths and a per-run total quietly compares different amounts of work.
        const wallMs = Date.now() - t0;
        const total = noSpend();
        for (const s of [audioSpend, judgeSpend, relSpend]) addSpend(total, s);
        const topics = nodes.filter((n) => n.kind === "topic" && n.id !== "root").length;
        const cardCount = nodes.filter((n) => n.kind !== "topic").length;
        send("report", {
          mode: mode.id,
          label: mode.label,
          audioSeconds: Math.round(want),
          chunks: chunks.length,
          chunkSeconds: mode.chunkSeconds,

          // Latency. First content is what the surface is judged on; wall clock is what a whole
          // meeting costs you.
          ttfTranscriptMs,
          ttfCardMs,
          wallMs,
          realtimeFactor: want > 0 ? +(want / (wallMs / 1000)).toFixed(1) : 0,

          // Cost, split by leg so the bottleneck is attributable.
          cost: {
            transcribe: +audioSpend.cost.toFixed(5),
            judge: +judgeSpend.cost.toFixed(5),
            relations: +relSpend.cost.toFixed(5),
            total: +total.cost.toFixed(5),
            perAudioHour: want > 0 ? +((total.cost / want) * 3600).toFixed(4) : 0,
          },
          calls: { transcribe: audioSpend.calls, judge: judgeSpend.calls, relations: relSpend.calls },

          // Accuracy proxies. None is ground truth — that needs your ears on the transcript — but
          // each one moves when the transcript gets worse:
          //   emptyChunks  a chunk that produced no transcript at all: minutes of the meeting simply
          //                missing. The chat arm's blank-reply bug shows up here.
          //   wastedCalls  retries that returned nothing. Cost with no output.
          //   topics       fragmentation. One subject heard four ways becomes four clusters, so a
          //                topic count far above ~6 for a short meeting means mishearing, not range.
          //   dropRate     share of proposed cards the server refused — an ungrounded quote (the
          //                model citing something nobody said) or a duplicate label. Both rise when
          //                the transcript is mush.
          //   speakers     distinct speaker labels the ENGINE returned. 0 on the chat arm is
          //                expected and means its speaker prefixes are invented; 0 on an stt arm
          //                means diarization did not survive OpenRouter.
          quality: {
            emptyChunks,
            wastedCalls: audioSpend.empties + judgeSpend.empties,
            transcriptLines: transcriptLines.length,
            topics,
            cards: cardCount,
            edges: edges.length,
            cardsProposed: rawCards,
            dropRate: rawCards ? +((rawCards - cardCount) / rawCards).toFixed(2) : 0,
            speakers,
            sttProfile,
          },
        });
        send("done", { nodes: nodes.length, edges: edges.length });
      } catch (e) {
        send("fail", { error: e instanceof Error ? e.message.slice(0, 300) : "unknown" });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/** Is this quote grounded in what was actually said? Word-overlap, not substring — see the note at
 *  the call site for why exact matching cannot work. */
function quoteIsGrounded(source: string, transcript: string[]): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const words = norm(source).split(" ").filter((w) => w.length > 2);
  if (words.length < 4) return false;              // too short to be evidence of anything
  const hay = new Set(norm(transcript.join(" ")).split(" "));
  const hits = words.filter((w) => hay.has(w)).length;
  return hits / words.length >= 0.65;
}

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
