// Live ingest: an audio file → transcript → canvas actions, streamed as SSE.
//
//   GET /api/canvas/live?minutes=1|2|5|10|0&mode=mimo|stt|stt-fast   (0 = whole file)
//
// Two phases, deliberately overlapped. Transcription runs several chunks CONCURRENTLY because it
// costs ~13s per audio-minute and the surface has to feel live; action derivation runs strictly IN
// ORDER because each call needs the board as it stood after the previous one. So chunk 4 may be
// transcribed while chunk 1 is still being judged, but chunk 1's cards always land first.
//
// `mode` selects an A/B arm (lib/canvas-modes.ts). Everything downstream of the transcript is
// identical across arms on purpose — same grounding rule, same dedupe, same fuzzy topic merge — so a
// difference in the board is a difference in what was HEARD, not in how it was handled. The run
// emits a `report` event at the end with the numbers the arms are being judged on.

import { NextRequest } from "next/server";
import { planChunks, sliceChunk } from "@/lib/audio";
import { addSpend, deriveActions, findRelations, glossaryFrom, noSpend, transcribe, type RawAction } from "@/lib/mimo";
import { resolveMode } from "@/lib/canvas-modes";
import type { GNode, Graph, NodeKind, NodeState } from "@/lib/canvas-graph";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const AUDIO = process.env.CANVAS_AUDIO_FILE ||
  "/Users/thomas/Downloads/YTDown.com_YouTube_OpenAI-Just-Made-Frontier-AI-Free-for-Ev_Media_g7r6snkyFzY_009_128k.mp3";

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

      const apply = (a: RawAction, lines: string[]): GNode | null => {
        if (!a.label) return null;
        const kind = (CARD_KINDS.has(a.kind as NodeKind) ? a.kind : "note") as NodeKind;
        if (!quoteIsGrounded(a.source ?? "", lines)) return null;

        // Chunks overlap by 6s, so the same sentence can legitimately be judged twice. Dedupe on the
        // label rather than trusting the model not to repeat itself.
        const key = a.label.trim().toLowerCase();
        if (seenLabels.has(key)) return null;
        seenLabels.add(key);

        const node: GNode = {
          id: `c${++seq}`,
          kind,
          parent: topicId(a.topic || "General"),
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
        const t0 = Date.now();
        const texts = new Map<number, Promise<string[]>>();
        const cards = new Map<number, Promise<RawAction[]>>();
        // Separate pools: transcription and derivation compete for the same provider, but starving
        // transcription is what makes the canvas look dead, so it gets its own budget.
        const runAudio = limiter(mode.concurrency);
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
            const buf = await sliceChunk(AUDIO, c.start, c.seconds);
            const r = await transcribe(mode.transcribe, buf, glossaryFrom(heard), audioSpend);
            if (r.speakers > speakers) speakers = r.speakers;
            sttProfile = r.profile;
            heard.push(...r.lines);
            return r.lines;
          })
            // Swallowing this error is what made three rounds of speed work guesswork: every failure
            // looked identical to "the model found nothing". Surface it.
            .catch((e) => { send("warn", { stage: "transcribe", index: c.index, error: String(e).slice(0, 200) }); return [] as string[]; });
          texts.set(c.index, text);
          cards.set(
            c.index,
            text.then((lines) =>
              lines.length
                ? runJudge(() => deriveActions(
                    topicNames(),
                    lines.join("\n"),
                    glossaryFrom(lines),
                    nodes.filter((n) => n.kind !== "topic").map((n) => n.label),
                    { cfg: mode.derive, spend: judgeSpend },
                  ))
                : ([] as RawAction[]),
            ).catch((e) => { send("warn", { stage: "derive", index: c.index, error: String(e).slice(0, 200) }); return [] as RawAction[]; }),
          );
        }

        // Two passes over the same promises: transcripts first (fast), then cards (slow). Both stay
        // in chunk order, so the panel reads chronologically even though everything ran at once.
        for (const c of chunks) {
          const lines = await texts.get(c.index)!;
          if (!lines.length) { emptyChunks++; continue; }
          transcriptLines.push(...lines);
          // Time to FIRST content is the number that decides whether the surface feels live; a
          // total that averages it away hides the 41s blank stare this pipeline used to open with.
          if (!ttfTranscriptMs) ttfTranscriptMs = Date.now() - t0;
          send("transcript", { index: c.index, at: fmt(c.start), lines, ms: Date.now() - t0 });
        }

        for (const c of chunks) {
          const lines = await texts.get(c.index)!;
          const raw = await cards.get(c.index)!;
          if (!lines.length) continue;
          rawCards += raw.length;
          const applied: GNode[] = [];
          // Two passes: create everything first, then bind relationships. A card often points at
          // another card in the SAME reply, and single-pass binding silently dropped every one of
          // those because the target didn't exist yet.
          for (const a of raw) { const n = apply(a, lines); if (n) applied.push(n); }
          for (const a of raw) {
            if (!a.relatesTo || !a.relation || !a.label) continue;
            const from = cardByLabel.get(a.label.trim().toLowerCase());
            const to = cardByLabel.get(a.relatesTo.trim().toLowerCase());
            if (from && to && from !== to && !edges.some((e) => e.from === from && e.to === to)) {
              edges.push({ from, to, kind: a.relation as never });
            }
          }
          if (!ttfCardMs && applied.length) ttfCardMs = Date.now() - t0;
          send("graph", {
            index: c.index,
            graph: {
              rev: c.index + 1, title: "Live transcript", subtitle: mode.label, status: "live",
              focus: applied[applied.length - 1]?.id,
              nodes, edges,
            } satisfies Graph,
            actions: applied.map((n) => ({ op: "card", kind: n.kind, label: n.label })),
            dropped: raw.length - applied.length,
            proposedRels: raw.filter((a) => a.relatesTo).length,
            timing: { sinceStartMs: Date.now() - t0 },
          });
        }
        // Relationships, once, over the finished board — the only point at which cross-chunk links
        // are visible at all.
        const links = await findRelations(
          nodes.filter((n) => n.kind !== "topic").map((n) => ({ id: n.id, kind: n.kind, label: n.label })),
          { cfg: mode.derive, spend: relSpend },
        );
        for (const l of links) {
          if (!edges.some((e) => e.from === l.from && e.to === l.to)) {
            edges.push({ from: l.from, to: l.to, kind: l.kind as never });
          }
        }
        if (links.length) {
          send("graph", {
            graph: { rev: 9999, title: "Live transcript", subtitle: mode.label, status: "live", nodes, edges } satisfies Graph,
            actions: links.map((l) => ({ op: "edge", kind: l.kind, label: `${l.from} → ${l.to}` })),
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
