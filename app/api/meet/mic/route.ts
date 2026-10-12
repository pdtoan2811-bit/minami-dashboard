// The phone's microphone leg into the meeting canvas (§17b). See lib/meet-mic.ts for the shape.
//
// POST /api/meet/mic?id=<meeting>&event=start   body { title?, context?, keep? } → opens + seeds the board
// POST /api/meet/mic?id=<meeting>               body = raw 16 kHz mono s16le PCM
// POST /api/meet/mic?id=<meeting>&event=end                                → flush, archive, summary
//
// Unauthenticated, like the rest of the dashboard on :3000: the dashboard is reachable only on
// loopback and the tailnet (`tailscale serve`, never Funnel — see remote-access). The meeting app on
// :3011 is the one that sits behind a public tunnel, and it never receives this route's traffic:
// the receiver forwards to /api/canvas/ingest only.

import { endMic, pushFrame, selfOrigin, startMic } from "@/lib/meet-mic";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A frame is ~0.5s (16 KB). Anything past a few seconds is a client bug or not audio at all. */
const MAX_FRAME_BYTES = 32 * 10_000;

export async function POST(req: Request) {
  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!/^phone-[\w-]{4,60}$/.test(id)) {
    // Scoped to its own prefix so a phone can never write into a Recall meeting's session.
    return Response.json({ ok: false, error: "id must look like phone-<…>" }, { status: 400 });
  }
  const event = url.searchParams.get("event");

  if (event === "start") {
    let b: { title?: string; context?: string; keep?: boolean } = {};
    try { b = await req.json(); } catch { /* all optional */ }
    const stats = await startMic(id, String(b.title || "").slice(0, 80), String(b.context || "").slice(0, 400), selfOrigin(req), { keep: b.keep === true });
    return Response.json({ ok: true, stats });
  }
  if (event === "end") {
    const r = await endMic(id);
    return Response.json({ ok: true, ...r });
  }

  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length || buf.length % 2 || buf.length > MAX_FRAME_BYTES) {
    return Response.json({ ok: false, error: `bad frame (${buf.length} bytes)` }, { status: 400 });
  }
  const stats = pushFrame(id, buf);
  // 409, not 404: the phone reads it as "this meeting is not open on the box" — typically a server
  // restart mid-meeting — and re-opens it rather than streaming into nothing.
  if (!stats) return Response.json({ ok: false, error: "meeting not open" }, { status: 409 });
  return Response.json({ ok: true, framesIn: stats.framesIn });
}
