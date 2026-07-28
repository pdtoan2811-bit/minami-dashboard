import { liveActivity } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → { activity: { [sessionId]: { phase, label, busy, elapsedMs } } } for every live dashboard-driven
// session. Polled by the bento grid so each running tile can show what it's doing, live.
export async function GET() {
  return Response.json({ activity: liveActivity() });
}
