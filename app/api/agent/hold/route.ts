import { setHold } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { key, hold: boolean } → arm/release the Flow view's brake on a live session. While armed,
// canUseTool parks every tool call at the gate instead of auto-approving it (see setHold in
// lib/agent/manager.ts), which is what makes step-by-step review possible on a bypassPermissions box.
//
// Deliberately NOT folded into /api/agent/mode: a hold is transient supervision, not a permission
// level, and expressing it as a mode change would mean releasing it rewrote the session's permissions.
export async function POST(req: Request) {
  try {
    const { key, hold } = await req.json();
    if (!key || typeof hold !== "boolean") {
      return Response.json({ error: "key and hold (boolean) are required" }, { status: 400 });
    }
    // Reports whether a LIVE session took it — the client reverts its toggle on false rather than
    // showing a brake that nothing is honouring.
    return Response.json({ ok: setHold(key, hold) });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
