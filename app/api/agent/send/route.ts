import { sendMessage } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { key, cwd, message, mode?, resume? } → feed a user message into a live session (creating it
// on the first call). Local-only: drives the machine's own Claude Code via the Agent SDK.
export async function POST(req: Request) {
  try {
    const { key, cwd, message, mode, resume } = await req.json();
    if (!key || !cwd || !message?.trim()) return Response.json({ error: "key, cwd and message are required" }, { status: 400 });
    const { sessionId } = sendMessage({ key, cwd, message: String(message), mode, resume });
    return Response.json({ ok: true, sessionId });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
