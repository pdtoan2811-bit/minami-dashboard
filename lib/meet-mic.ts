// PHONE MIC → MEETING CANVAS (§17b). The phone is the microphone; nothing joins a call.
//
//   phone /meet → POST /api/meet/mic (16 kHz s16le PCM, ~0.5s per frame)
//               → the SAME utterance chunker the Recall receiver uses
//               → the SAME ingest handler, in-process → /api/canvas → the board
//
// Why the chunker runs here and not in the browser: it is the part of the pipeline that decides
// what counts as speech, and it is tuned by real meetings (silence window, min speech, the peak-
// relative floor). A second copy in the client would drift from it exactly the way the two tunnel
// launchers drifted (§18). The phone only resamples and ships; every judgement stays on the box.
//
// Why ingest is called in-process rather than over HTTP: the publish leg inside ingest builds its
// /api/canvas URL from the request URL. A request arriving through `tailscale serve` carries the
// tailnet hostname, so a fetch from the Mac to itself would leave over the tailnet and back. The
// synthetic Request below is addressed to loopback, so publish stays on loopback too.

import { createChunker, normalisePcm, wav, BYTES_PER_MS } from "@/server/utterance-chunker.mjs";
import { POST as ingest } from "@/app/api/canvas/ingest/route";

const TOKEN = process.env.CANVAS_INGEST_TOKEN || "";
const PORT = process.env.PORT || "3000";
/** Same ceiling the receiver uses (CANVAS_MIC_GAIN_MAX) — a phone held at arm's length across a
 *  table is the quiet-speaker case that number was chosen for. */
const GAIN_MAX = Number(process.env.CANVAS_MIC_GAIN_MAX || 2.0);

export type MicStats = {
  id: string;
  title: string;
  startedAt: number;
  /** Phone → box. If this stops, the phone stopped sending (screen off, tab backgrounded, network). */
  framesIn: number;
  audioMsIn: number;
  lastFrameAt: number | null;
  /** Loudness of the last frame, 0..1 of full scale — the server's own view of the mic level, so the
   *  phone can show "the box hears you" rather than only "your mic moves". */
  level: number;
  /** Chunker → ingest. Utterances cut on the speaker's pauses. */
  chunksOut: number;
  lastChunkAt: number | null;
  lastChunkMs: number;
  inflight: number;
  /** What ingest said about the last utterance — heard N lines, queued, skipped, failed. */
  lastResult: { at: number; status: number; note: string } | null;
  errors: { at: number; text: string }[];
  ended: boolean;
};

type Mic = { stats: MicStats; chunker: ReturnType<typeof createChunker>; origin: string };

/** On globalThis for the reason every canvas store is: a dev hot-reload must not orphan a meeting
 *  that is in progress. */
const mics: Map<string, Mic> =
  (globalThis as { __meetMics?: Map<string, Mic> }).__meetMics ??
  ((globalThis as { __meetMics?: Map<string, Mic> }).__meetMics = new Map());

/** The participant every phone frame is filed under. One mic in a room hears everyone, so there is
 *  no honest name to give — ingest already handles a null speaker (Recall's unnamed channels). */
const ROOM = { id: "phone", name: null };

function note(stats: MicStats, text: string) {
  stats.errors.push({ at: Date.now(), text: text.slice(0, 200) });
  if (stats.errors.length > 8) stats.errors.shift();
}

/** Where this process can reach itself. A request that arrived on loopback names its own port; one
 *  that came through `tailscale serve` carries the tailnet host, so fall back to PORT (serve.sh sets
 *  it; `next start -p` does too). Getting this wrong is silent and bad: the board would be published
 *  to whichever server owns that port — on this box, the live dashboard. */
export function selfOrigin(req: Request): string {
  const u = new URL(req.url);
  return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ? u.origin : `http://127.0.0.1:${PORT}`;
}

async function callIngest(origin: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await ingest(
    new Request(`${origin}/api/canvas/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
  let json: Record<string, unknown> = {};
  try { json = (await r.json()) as Record<string, unknown>; } catch { /* non-JSON error page */ }
  return { status: r.status, json };
}

function describe(status: number, j: Record<string, unknown>): string {
  if (status >= 400) return String(j.error ?? `HTTP ${status}`);
  if (j.skipped) return `skipped — ${j.skipped}`;
  if (j.ignored) return `ignored — ${j.ignored}`;
  if (typeof j.heard === "number") return `heard ${j.heard} line(s) · ${j.cards ?? 0} cards${j.queued ? ` · ${j.queued} judging` : ""}`;
  if (j.commands) return `command applied`;
  return "ok";
}

async function sendChunk(m: Mic, chunk: { pcm: Buffer; speechMs: number; totalMs: number }) {
  const s = m.stats;
  s.chunksOut++;
  s.lastChunkAt = Date.now();
  s.lastChunkMs = Math.round(chunk.totalMs);
  s.inflight++;
  const boosted = normalisePcm(chunk.pcm, { maxGain: GAIN_MAX });
  const body = {
    meetingId: s.id,
    speaker: null,
    speechMs: Math.round(chunk.speechMs),
    totalMs: Math.round(chunk.totalMs),
    audio: wav(boosted.pcm).toString("base64"),
    format: "wav",
    gain: +boosted.gain.toFixed(2),
  };
  try {
    let r = await callIngest(m.origin, body);
    // One retry on a transcriber failure, byte-identical, as the receiver does. Not on 4xx: those are
    // configuration (token) and retrying only doubles the noise.
    if (r.status >= 500 && r.status !== 503) {
      await new Promise((ok) => setTimeout(ok, 1500));
      r = await callIngest(m.origin, body);
    }
    s.lastResult = { at: Date.now(), status: r.status, note: describe(r.status, r.json) };
    if (r.status >= 400) note(s, `ingest ${r.status}: ${describe(r.status, r.json)}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    s.lastResult = { at: Date.now(), status: 0, note: msg };
    note(s, `ingest threw: ${msg}`);
  } finally {
    s.inflight--;
  }
}

export async function startMic(id: string, title: string, context: string, origin: string): Promise<MicStats> {
  const existing = mics.get(id);
  if (existing && !existing.stats.ended) return existing.stats;
  const stats: MicStats = {
    id, title, startedAt: Date.now(), framesIn: 0, audioMsIn: 0, lastFrameAt: null, level: 0,
    chunksOut: 0, lastChunkAt: null, lastChunkMs: 0, inflight: 0, lastResult: null, errors: [], ended: false,
  };
  const m: Mic = { stats, chunker: null as unknown as Mic["chunker"], origin };
  m.chunker = createChunker((chunk: { pcm: Buffer; speechMs: number; totalMs: number }) => { void sendChunk(m, chunk); });
  mics.set(id, m);
  // Seed even with no context: it opens the board under this meeting id, so the phone's board view
  // has a frame to pin to before the first word.
  const r = await callIngest(origin, { meetingId: id, event: "seed", context: [title, context].filter(Boolean).join("\n") });
  if (r.status >= 400) note(stats, `seed ${r.status}: ${describe(r.status, r.json)}`);
  return stats;
}

export function pushFrame(id: string, pcm: Buffer): MicStats | null {
  const m = mics.get(id);
  if (!m || m.stats.ended) return null;
  const s = m.stats;
  s.framesIn++;
  s.audioMsIn += pcm.length / BYTES_PER_MS;
  s.lastFrameAt = Date.now();
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  s.level = +(peak / 32768).toFixed(3);
  m.chunker.push(ROOM, pcm);
  return s;
}

export async function endMic(id: string): Promise<{ stats: MicStats | null; summary: unknown }> {
  const m = mics.get(id);
  if (!m) return { stats: null, summary: null };
  if (m.stats.ended) return { stats: m.stats, summary: null };
  // Flush the half-finished utterance first, then give in-flight sends a bounded moment to land —
  // ingest's own `end` drains its judges, but it cannot drain a request that has not reached it yet.
  m.chunker.end();
  const until = Date.now() + 8000;
  while (m.stats.inflight > 0 && Date.now() < until) await new Promise((ok) => setTimeout(ok, 200));
  m.stats.ended = true;
  const r = await callIngest(m.origin, { meetingId: id, event: "end" });
  return { stats: m.stats, summary: r.json.summary ?? null };
}

export function micStats(id: string): MicStats | null {
  return mics.get(id)?.stats ?? null;
}
