import { liveActivity } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → { activity: { [sessionId]: { phase, label, busy, elapsedMs } } } for every live dashboard-driven
// session. Polled by the bento grid so each running tile can show what it's doing, live.
export async function GET() {
  // Every sibling route wraps its body in try/catch; this is the one poll hit continuously by the grid
  // (every open tab, every couple seconds) — if liveActivity() ever throws on some unexpected session
  // state, this would otherwise return Next's HTML error page instead of JSON, and the client's
  // `.json()` call throws on that repeatedly until whatever triggered it clears.
  try {
    return Response.json({ activity: liveActivity() });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
