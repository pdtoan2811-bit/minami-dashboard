// Audio slicing for the canvas ingest pipeline.
//
// Chunk size is a real trade-off, not a detail. Measured: ~13s of wall clock per 60s of audio. A
// single 10-minute call would therefore take over two minutes before ANYTHING appeared on screen —
// which for a surface whose whole job is feeling live is fatal. Slicing into 60s chunks and running
// several at once means first content lands in ~15s regardless of how much you selected.
//
// 60s is also about the longest chunk that still transcribes reliably in one pass, and short enough
// that losing one to an error costs a minute rather than the meeting.

import { spawn } from "node:child_process";

const FFMPEG = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "/opt/homebrew/bin/ffprobe";

export const CHUNK_SECONDS = 60;
/** Seconds of the previous chunk repeated at the start of the next.
 *
 *  A 60s cut lands mid-sentence roughly every time — the first test ended a chunk on "I feel like
 *  part of the push here was…", so the next chunk opened mid-thought and the model was asked to
 *  judge a fragment. Overlapping means every sentence appears whole in at least one chunk. The cost
 *  is a little duplicated transcript, which the model already tolerates (rule: don't re-react to
 *  lines you've seen). */
export const OVERLAP_SECONDS = 6;

function run(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${bin} exited ${code}: ${err.slice(0, 300)}`)),
    );
  });
}

export async function durationSeconds(file: string): Promise<number> {
  const out = await run(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  return parseFloat(out.toString().trim()) || 0;
}

/** One chunk as an mp3 buffer, downmixed to mono 16 kHz.
 *
 *  Speech carries no useful information above ~8 kHz and none in the second channel, so this is
 *  lossless for the purpose while cutting the base64 payload roughly 10x — 235 KB instead of ~2 MB
 *  per minute. That size is what makes running several chunks concurrently practical. */
export async function sliceChunk(file: string, startSec: number, seconds: number): Promise<Buffer> {
  return run(FFMPEG, [
    "-v", "error",
    "-ss", String(startSec),
    "-t", String(seconds),
    "-i", file,
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "32k",
    "-f", "mp3",
    "pipe:1",
  ]);
}

/** Chunk boundaries for the first `minutes` of a file (0 or negative = the whole thing). */
export async function planChunks(file: string, minutes: number) {
  const total = await durationSeconds(file);
  const want = minutes > 0 ? Math.min(minutes * 60, total) : total;
  const chunks: { index: number; start: number; seconds: number }[] = [];
  for (let s = 0, i = 0; s < want; s += CHUNK_SECONDS, i++) {
    const start = Math.max(0, s - (i ? OVERLAP_SECONDS : 0));
    chunks.push({ index: i, start, seconds: Math.min(CHUNK_SECONDS + (i ? OVERLAP_SECONDS : 0), want - start) });
  }
  return { total, want, chunks };
}
