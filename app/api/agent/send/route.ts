import fs from "node:fs";
import { sendMessage } from "@/lib/agent/manager";
import { imageBlocksFor } from "@/lib/agent/images";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { key, cwd, message, mode?, resume?, hold? } → feed a user message into a live session
// (creating it on the first call). Local-only: drives the machine's own Claude Code via the Agent SDK.
//
// `hold` carries the Flow view's brake in WITH the message — see sendMessage for why arming it as a
// separate request can't work for the first turn of a session.
export async function POST(req: Request) {
  try {
    const { key, cwd, message, mode, resume, hold } = await req.json();
    // typeof-guard before .trim(): a non-string truthy `message` (number, object, array) would otherwise
    // throw inside this try and come back as a 500 "message.trim is not a function" instead of the clean
    // 400 this validation is meant to produce.
    if (!key || !cwd || typeof message !== "string" || !message.trim()) return Response.json({ error: "key, cwd and message are required" }, { status: 400 });
    // `cwd` was only ever checked for truthiness, which let a non-existent directory through to
    // `query({ cwd })`. The SDK subprocess then fails to spawn, and because that happens before the
    // first turn completes it never emits a `result` — so the pane just sat there having produced no
    // reply, no transcript, and no project tile, with only a clipped error to explain itself. Fail here
    // instead, with something a human can act on.
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(cwd); } catch { /* missing or unreadable — reported below */ }
    if (!stat) return Response.json({ error: `folder does not exist: ${cwd}` }, { status: 400 });
    if (!stat.isDirectory()) return Response.json({ error: `not a folder: ${cwd}` }, { status: 400 });
    // Any image path the message mentions — pasted, or picked with the attach button — is read here
    // and sent inline, so Claude sees the picture in the same turn instead of spending a Read call on
    // it. The path stays in the text regardless: that is what survives into the transcript (user turns
    // keep only text blocks) and what lets the panel re-render the thumbnail after a reload.
    // Deliberately best-effort — a missing or oversized file degrades to the old path-only behaviour
    // rather than failing the send.
    const images = await imageBlocksFor(String(message));
    const { sessionId } = sendMessage({ key, cwd, message: String(message), mode, resume, images, hold: typeof hold === "boolean" ? hold : undefined });
    return Response.json({ ok: true, sessionId });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
