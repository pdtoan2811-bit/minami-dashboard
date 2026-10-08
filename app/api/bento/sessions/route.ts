import { listSessions } from "@/lib/claude-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Local-only: reads ~/.claude/projects. On Vercel (no access to the user's home) this returns [].
//
// `?ids=a,b` narrows the reply to those sessions. /glance (§23) needs three titles, and the full list
// is every session on the box (hundreds of KB) — over a phone's tailnet link on every refresh. The
// server-side cost is the same either way (listSessions is cached); only the payload shrinks.
// listSessions() is synchronous — a readdir over every project, a stat per transcript, the cache
// parse — about 5 ms that blocks every other request, and it grows with the number of transcripts.
// Every open tab and phone polls this, and a burst of 20 measured p99 93–182 ms on /api/agent/live
// (audit 2026-10-08). One result is shared for SHARE_MS: nothing on the board changes faster than that.
const SHARE_MS = 1000;
let shared: { at: number; v: ReturnType<typeof listSessions> } | null = null;
function sessionsNow() {
  if (shared && Date.now() - shared.at < SHARE_MS) return shared.v;
  shared = { at: Date.now(), v: listSessions() };
  return shared.v;
}

export async function GET(req: Request) {
  try {
    const ids = new URL(req.url).searchParams.get("ids");
    const all = sessionsNow();
    if (!ids) return Response.json({ sessions: all });
    const want = new Set(ids.split(",").filter(Boolean));
    return Response.json({ sessions: all.filter((s) => want.has(s.id)) });
  } catch {
    return Response.json({ sessions: [] });
  }
}
