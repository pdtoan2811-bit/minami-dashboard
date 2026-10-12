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
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const TOKEN = process.env.CANVAS_INGEST_TOKEN || "";
const PORT = process.env.PORT || "3000";
/** Same ceiling the receiver uses (CANVAS_MIC_GAIN_MAX) — a phone held at arm's length across a
 *  table is the quiet-speaker case that number was chosen for. */
const GAIN_MAX = Number(process.env.CANVAS_MIC_GAIN_MAX || 2.0);
const FFMPEG = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
/** Scratch for audio that has not been archived yet: uploads being fed, and the running PCM of a
 *  meeting whose audio is being kept. Emptied at end — only the archive folder keeps a copy. */
const AUDIO_TMP = process.env.MEET_AUDIO_TMP || `${process.env.HOME}/.minami/meet-audio`;
/** 0.5s of 16 kHz s16le — the same frame the phone sends, so a recording and a live mic look
 *  identical to everything downstream of pushFrame. */
const FRAME_BYTES = 16_000;

export type Summary = { utterances?: number; cards?: number; topics?: number; minutes?: number; cost?: number; archived?: string | null };

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
  /** Where the audio comes from. A file is fed by the box itself, paced, so the phone may leave. */
  source: "mic" | "file";
  file: { name: string; totalMs: number | null; doneMs: number; speed: number; finished: boolean } | null;
  /** Keep the meeting's audio in its archive folder. Off by default: this is real meeting audio, the
   *  same reason the receiver's CANVAS_DUMP_DIR is off by default. */
  keep: boolean;
  /** Set once at end, so a screen that reloads (or a phone that left during a recording) still gets
   *  the outcome. The transcript is left out — it can be long, and it is in the archive. */
  summary: Summary | null;
  audioSaved: string | null;
};

type Mic = {
  stats: MicStats; chunker: ReturnType<typeof createChunker>; origin: string;
  /** Running PCM on disk when `keep` is on. Appended per frame: an hour is ~115 MB, not for RAM. */
  pcmPath: string | null;
  /** The uploaded file when source is "file". */
  upload: string | null;
  proc: ChildProcess | null;
  cancelled: boolean;
};

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

export async function startMic(
  id: string, title: string, context: string, origin: string,
  opts: { keep?: boolean; source?: "mic" | "file" } = {},
): Promise<MicStats> {
  const existing = mics.get(id);
  if (existing && !existing.stats.ended) return existing.stats;
  const stats: MicStats = {
    id, title, startedAt: Date.now(), framesIn: 0, audioMsIn: 0, lastFrameAt: null, level: 0,
    chunksOut: 0, lastChunkAt: null, lastChunkMs: 0, inflight: 0, lastResult: null, errors: [], ended: false,
    source: opts.source ?? "mic", file: null, keep: Boolean(opts.keep), summary: null, audioSaved: null,
  };
  let pcmPath: string | null = null;
  // A file source keeps the ORIGINAL file instead (no generation loss, and it is already compressed).
  if (stats.keep && stats.source === "mic") {
    mkdirSync(AUDIO_TMP, { recursive: true });
    pcmPath = join(AUDIO_TMP, `${id}.pcm`);
    rmSync(pcmPath, { force: true });
  }
  const m: Mic = { stats, chunker: null as unknown as Mic["chunker"], origin, pcmPath, upload: null, proc: null, cancelled: false };
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
  if (m.pcmPath) {
    try { appendFileSync(m.pcmPath, pcm); } catch (e) { m.pcmPath = null; note(s, `keeping audio failed: ${e instanceof Error ? e.message : e}`); }
  }
  m.chunker.push(ROOM, pcm);
  return s;
}

export async function endMic(id: string): Promise<{ stats: MicStats | null; summary: unknown }> {
  const m = mics.get(id);
  if (!m) return { stats: null, summary: null };
  if (m.stats.ended) return { stats: m.stats, summary: m.stats.summary };
  // A recording still being fed: stop the feeder first, or it keeps pushing into a closed meeting.
  m.cancelled = true;
  m.proc?.kill("SIGKILL");
  // Flush the half-finished utterance first, then give in-flight sends a bounded moment to land —
  // ingest's own `end` drains its judges, but it cannot drain a request that has not reached it yet.
  m.chunker.end();
  const until = Date.now() + 8000;
  while (m.stats.inflight > 0 && Date.now() < until) await new Promise((ok) => setTimeout(ok, 200));
  m.stats.ended = true;
  const r = await callIngest(m.origin, { meetingId: id, event: "end" });
  const full = (r.json.summary ?? null) as (Summary & { transcript?: unknown }) | null;
  const { transcript: _t, ...rest } = full ?? {};
  // Audio first, summary second: the summary is what the phone reads as "finished", so publishing it
  // before the audio is saved would show "not saved" for the seconds the AAC encode takes.
  await saveAudio(m, rest.archived ?? null);
  m.stats.summary = full ? rest : {};
  return { stats: m.stats, summary: full };
}

/** Put the kept audio next to the meeting's notes, then clear the scratch copy either way. */
async function saveAudio(m: Mic, archived: string | null) {
  const s = m.stats;
  try {
    if (s.keep && archived && existsSync(archived)) {
      if (m.upload) {
        const out = join(archived, `recording${extname(m.upload) || ".audio"}`);
        copyFileSync(m.upload, out);
        s.audioSaved = out;
      } else if (m.pcmPath && existsSync(m.pcmPath)) {
        // AAC at 32 kbps mono: ~14 MB an hour, plenty for speech, and plays everywhere.
        const out = join(archived, "recording.m4a");
        await run(FFMPEG, ["-loglevel", "error", "-y", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", m.pcmPath, "-c:a", "aac", "-b:a", "32k", out]);
        s.audioSaved = out;
      }
    }
  } catch (e) {
    note(s, `saving the recording failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    if (m.pcmPath) rmSync(m.pcmPath, { force: true });
    if (m.upload) rmSync(m.upload, { force: true });
    m.pcmPath = m.upload = null;
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", fail);
    p.on("close", (code) => (code === 0 ? ok(out) : fail(new Error(err.trim().split("\n").pop() || `${basename(cmd)} exited ${code}`))));
  });
}

/** Where an upload should be written before feeding. */
export function uploadPath(id: string, name: string): string {
  mkdirSync(AUDIO_TMP, { recursive: true });
  const ext = (extname(name) || ".audio").toLowerCase().replace(/[^.\w]/g, "").slice(0, 8);
  return join(AUDIO_TMP, `${id}${ext}`);
}

/** Play a recording through the live pipeline, paced, so the board and its memes build the way they
 *  would have in the room.
 *
 *  ⚠️ PACED, NOT AS FAST AS POSSIBLE. Unpaced, an hour of audio becomes ~360 utterances inside a
 *  minute, ingest's MAX_QUEUED_JUDGES starts dropping speech as "backlog" — exactly the silent loss
 *  the dead-man's switch exists to catch — and nobody watching the screen sees anything build.
 *  4x keeps about one utterance in flight every 2.5s, inside what concurrent judges absorb. */
export async function feedRecording(id: string, file: string, name: string, speed: number) {
  const m = mics.get(id);
  if (!m || m.stats.ended) return;
  const s = m.stats;
  m.upload = file;
  let totalMs: number | null = null;
  try {
    const probe = await run(join(dirname(FFMPEG), "ffprobe"), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    const sec = parseFloat(probe);
    if (Number.isFinite(sec)) totalMs = Math.round(sec * 1000);
  } catch { /* no ffprobe: the strip shows elapsed without a total */ }
  s.file = { name: name.slice(0, 120), totalMs, doneMs: 0, speed, finished: false };

  const proc = spawn(FFMPEG, ["-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"]);
  m.proc = proc;
  let err = "";
  proc.stderr.on("data", (d) => (err += d));
  let buf: Buffer = Buffer.alloc(0);
  const wait = 500 / speed;
  let next = Date.now();
  try {
    // for-await pauses reading while we sleep, so ffmpeg is held back by the pipe rather than
    // decoding the whole file into memory ahead of the pacing.
    for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= FRAME_BYTES) {
        if (m.cancelled) return;
        pushFrame(id, buf.subarray(0, FRAME_BYTES));
        buf = buf.subarray(FRAME_BYTES);
        s.file.doneMs += 500;
        // A deadline clock, not a sleep per frame: sleeps drift late under load and an hour at 4x
        // would quietly become 4x-minus-a-bit with nobody able to say why.
        next += wait;
        const d = next - Date.now();
        if (d > 0) await new Promise((ok) => setTimeout(ok, d));
      }
    }
    if (m.cancelled) return;
    if (buf.length >= 2) pushFrame(id, buf.subarray(0, buf.length - (buf.length % 2)));
    const code: number | null = proc.exitCode ?? (await new Promise((ok) => proc.on("close", ok)));
    if (code) note(s, `could not read the recording: ${err.trim().split("\n").pop() || `ffmpeg exited ${code}`}`);
  } catch (e) {
    note(s, `feeding the recording failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    m.proc = null;
  }
  if (m.cancelled) return;
  s.file.finished = true;
  await endMic(id);
}

/** The newest phone meeting still running — what a room screen at /meet/screen should follow. */
export function latestMic(): MicStats | null {
  let best: MicStats | null = null;
  for (const { stats } of mics.values()) {
    if (stats.ended) continue;
    if (!best || stats.startedAt > best.startedAt) best = stats;
  }
  return best;
}

export function micStats(id: string): MicStats | null {
  return mics.get(id)?.stats ?? null;
}
