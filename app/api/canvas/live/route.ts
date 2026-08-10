// Live ingest: an audio file → transcript → canvas actions, streamed as SSE.
//
//   GET /api/canvas/live?minutes=1|2|5|10|0   (0 = whole file)
//
// Two phases, deliberately overlapped. Transcription runs several chunks CONCURRENTLY because it
// costs ~13s per audio-minute and the surface has to feel live; action derivation runs strictly IN
// ORDER because each call needs the board as it stood after the previous one. So chunk 4 may be
// transcribed while chunk 1 is still being judged, but chunk 1's cards always land first.

import { NextRequest } from "next/server";
import { planChunks, sliceChunk } from "@/lib/audio";
import { deriveActions, glossaryFrom, transcribe, type RawAction } from "@/lib/mimo";
import type { GNode, Graph, NodeKind, NodeState } from "@/lib/canvas-graph";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const AUDIO = process.env.CANVAS_AUDIO_FILE ||
  "/Users/thomas/Downloads/YTDown.com_YouTube_OpenAI-Just-Made-Frontier-AI-Free-for-Ev_Media_g7r6snkyFzY_009_128k.mp3";

const CARD_KINDS = new Set<NodeKind>([
  "decision", "requirement", "question", "risk", "milestone", "action", "quote", "aside", "note",
]);
const STATES = new Set<NodeState>(["proposed", "agreed", "done", "blocked", "open"]);
/** How many chunks transcribe at once. Enough to hide the per-chunk latency, low enough to stay
 *  well inside rate limits and not blow the machine's socket budget. */
const CONCURRENCY = 3;

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
  const minutes = Number(new URL(req.url).searchParams.get("minutes") ?? "1");
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
      let seq = 0;
      const transcriptLines: string[] = [];
      const seenLabels = new Set<string>();

      const topicId = (name: string) => {
        const key = name.trim().toLowerCase().slice(0, 40);
        const hit = topicByName.get(key);
        if (hit) return hit;
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
        return node;
      };

      try {
        const { chunks, want } = await planChunks(AUDIO, minutes);
        send("meta", { chunks: chunks.length, seconds: Math.round(want) });
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
        const runAudio = limiter(CONCURRENCY);
        const runJudge = limiter(CONCURRENCY);

        for (const c of chunks) {
          const text = runAudio(() => sliceChunk(AUDIO, c.start, c.seconds).then(transcribe))
            .then((t) => t.split("\n").map((l) => l.trim()).filter((l) => l.length > 1))
            // Swallowing this error is what made three rounds of speed work guesswork: every failure
            // looked identical to "the model found nothing". Surface it.
            .catch((e) => { send("warn", { stage: "transcribe", index: c.index, error: String(e).slice(0, 200) }); return [] as string[]; });
          texts.set(c.index, text);
          cards.set(
            c.index,
            text.then((lines) =>
              lines.length
                ? runJudge(() => deriveActions(topicNames(), lines.join("\n"), glossaryFrom(lines)))
                : ([] as RawAction[]),
            ).catch((e) => { send("warn", { stage: "derive", index: c.index, error: String(e).slice(0, 200) }); return [] as RawAction[]; }),
          );
        }

        // Two passes over the same promises: transcripts first (fast), then cards (slow). Both stay
        // in chunk order, so the panel reads chronologically even though everything ran at once.
        for (const c of chunks) {
          const lines = await texts.get(c.index)!;
          if (!lines.length) continue;
          transcriptLines.push(...lines);
          send("transcript", { index: c.index, at: fmt(c.start), lines, ms: Date.now() - t0 });
        }

        for (const c of chunks) {
          const lines = await texts.get(c.index)!;
          const raw = await cards.get(c.index)!;
          if (!lines.length) continue;
          const applied: GNode[] = [];
          for (const a of raw) { const n = apply(a, lines); if (n) applied.push(n); }
          send("graph", {
            index: c.index,
            graph: {
              rev: c.index + 1, title: "Live transcript", subtitle: "mimo-v2.5", status: "live",
              focus: applied[applied.length - 1]?.id,
              nodes,
            } satisfies Graph,
            actions: applied.map((n) => ({ op: "card", kind: n.kind, label: n.label })),
            dropped: raw.length - applied.length,
            timing: { sinceStartMs: Date.now() - t0 },
          });
        }
        send("done", { nodes: nodes.length });
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
