// POST /api/agent/transcribe — a voice note from the composer's 🎤 → text for the message box (§3).
//
// Claude takes text and images, not audio, so the chat can't be handed the recording. The note is
// transcribed here by the meeting ear (§17: the omni model in lib/canvas-modes, benched on Thomas's own
// Vietnamese-with-English-terms speech), and the TEXT goes into the composer for him to read before
// sending. Nothing is sent on his behalf.
//
// Body: a 16 kHz mono 16-bit WAV (lib/pcm-client.ts). Returns { text, seconds, ms, model }.

import { transcribe } from "@/lib/canvas-llm";
import { resolveMode } from "@/lib/canvas-modes";
import { correctLines, loadVocab } from "@/server/canvas-vocab.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RATE = 16_000;
const BYTES_PER_S = RATE * 2;
/** Ten minutes. A voice note, not a meeting — /meet is for those. */
const MAX_S = 600;
/** Pieces are transcribed separately. One long call is where the omni ear has looped before (§17,
 *  repetition collapse), and its output cap scales with audio length; 45 s is well inside both. */
const PIECE_S = 45;
/** How far either side of a cut to look for the quietest 50 ms, so a word isn't sliced in half. */
const SEEK_S = 1.5;

function rmsAt(pcm: Buffer, from: number, n: number): number {
  let s = 0, k = 0;
  for (let i = from; i + 1 < Math.min(from + n, pcm.length); i += 2) { const v = pcm.readInt16LE(i); s += v * v; k++; }
  return k ? Math.sqrt(s / k) : 0;
}

/** Cut points (byte offsets) near every PIECE_S, each moved to the quietest 50 ms within ±SEEK_S. */
function cuts(pcm: Buffer): number[] {
  const out = [0];
  const win = (BYTES_PER_S / 20) & ~1;
  for (let target = PIECE_S * BYTES_PER_S; target < pcm.length - 5 * BYTES_PER_S; target += PIECE_S * BYTES_PER_S) {
    let best = target, bestV = Infinity;
    for (let at = Math.max(0, target - SEEK_S * BYTES_PER_S); at < Math.min(pcm.length - win, target + SEEK_S * BYTES_PER_S); at += win) {
      const v = rmsAt(pcm, at, win);
      if (v < bestV) { bestV = v; best = at; }
    }
    out.push(best & ~1);
  }
  out.push(pcm.length);
  return out;
}

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(BYTES_PER_S, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export async function POST(req: Request) {
  const body = Buffer.from(await req.arrayBuffer());
  if (body.length < 44 || body.toString("ascii", 0, 4) !== "RIFF" || body.toString("ascii", 8, 12) !== "WAVE") {
    return Response.json({ ok: false, error: "expected a WAV recording" }, { status: 400 });
  }
  if (body.readUInt32LE(24) !== RATE || body.readUInt16LE(22) !== 1 || body.readUInt16LE(34) !== 16) {
    return Response.json({ ok: false, error: "expected 16 kHz mono 16-bit audio" }, { status: 400 });
  }
  const pcm = body.subarray(44);
  const seconds = pcm.length / BYTES_PER_S;
  if (seconds < 0.4) return Response.json({ ok: true, text: "", seconds, ms: 0, model: null });
  if (seconds > MAX_S) return Response.json({ ok: false, error: `too long (${Math.round(seconds)} s; the limit is ${MAX_S / 60} min)` }, { status: 413 });

  const ear = resolveMode(null).transcribe;
  const vocab = loadVocab();
  // Spelling hints only: names and product words he says often (the meeting ear's own vocabulary).
  const terms = (vocab.terms ?? []).slice(0, 40);
  const t0 = Date.now();
  const at = cuts(pcm);
  const pieces = at.slice(0, -1).map((a, i) => pcm.subarray(a, at[i + 1]));
  try {
    // Three at a time: a 10-minute note is 14 pieces, and all-at-once is how a provider rate-limits.
    const texts: string[] = new Array(pieces.length).fill("");
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, pieces.length) }, async () => {
      for (let i = next++; i < pieces.length; i = next++) {
        const r = await transcribe(ear, wav(pieces[i]), terms, undefined, "wav");
        const { corrected } = correctLines(r.lines, vocab);
        texts[i] = corrected.join(" ").trim();
      }
    }));
    const text = texts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return Response.json({ ok: true, text, seconds: Math.round(seconds), ms: Date.now() - t0, model: ear.model, pieces: pieces.length });
  } catch (e) {
    return Response.json({ ok: false, error: `transcription failed — ${e instanceof Error ? e.message.slice(0, 160) : "unknown"}` }, { status: 502 });
  }
}
