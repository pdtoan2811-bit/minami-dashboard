// A recorded meeting through the live pipeline (§17b). The phone (or any browser) uploads the file
// as the request body; the box decodes it with ffmpeg and feeds it, paced, exactly as if a mic were
// hearing it, so the board, the memes and the archive come out the same as a live meeting.
//
// POST /api/meet/recording?id=phone-…&name=<file name>&speed=1|2|4|8&keep=1&title=…
//
// Decoding happens HERE, not in the browser: decodeAudioData on an hour of audio is a ~1 GB float
// buffer, which a phone tab will not survive. Uploading the compressed file is also the smaller
// transfer by an order of magnitude.

import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { feedRecording, selfOrigin, startMic, uploadPath } from "@/lib/meet-mic";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

/** ~5 hours of a typical phone recording. Past this it is not a meeting. */
const MAX_BYTES = 600 * 1024 * 1024;
const SPEEDS = [1, 2, 4, 8];

export async function POST(req: Request) {
  const q = new URL(req.url).searchParams;
  const id = (q.get("id") || "").trim();
  if (!/^phone-[\w-]{4,60}$/.test(id)) return Response.json({ ok: false, error: "id must look like phone-<…>" }, { status: 400 });
  if (!req.body) return Response.json({ ok: false, error: "no file in the request body" }, { status: 400 });
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) return Response.json({ ok: false, error: "file too large (600 MB max)" }, { status: 413 });

  const name = (q.get("name") || "recording").slice(0, 120);
  const speed = SPEEDS.includes(Number(q.get("speed"))) ? Number(q.get("speed")) : 4;
  const path = uploadPath(id, name);
  try {
    await pipeline(Readable.fromWeb(req.body as import("node:stream/web").ReadableStream), createWriteStream(path));
    const size = (await stat(path)).size;
    if (size > MAX_BYTES) throw new Error("file too large (600 MB max)");
    if (size < 1000) throw new Error("that file is empty");
  } catch (e) {
    await rm(path, { force: true });
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }

  const title = (q.get("title") || name.replace(/\.[^.]+$/, "")).slice(0, 80);
  const stats = await startMic(id, title, "", selfOrigin(req), { keep: q.get("keep") === "1", source: "file" });
  // Not awaited: the upload request returns now and the box carries on alone, so the phone can lock
  // its screen or walk away and the meeting still finishes and archives itself.
  void feedRecording(id, path, name, speed);
  return Response.json({ ok: true, stats, speed });
}
