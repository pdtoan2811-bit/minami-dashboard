import { markPresence } from "@/lib/push/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { sessionId, gone? } → "this chat is on someone's screen right now" (§24). Pushes for a chat
// pinged here in the last 45s are held back — and sent when the pings stop, if it is still blocked.
// `gone` (sent by sendBeacon when the page is hidden) ends presence at once: locking the phone while
// looking at a question is the moment the notification is most needed, not 45s later.
export async function POST(req: Request) {
  try {
    const { sessionId, gone } = JSON.parse(await req.text());
    if (typeof sessionId !== "string" || !sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });
    await markPresence(sessionId, !!gone);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
