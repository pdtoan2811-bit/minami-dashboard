import { listSessions } from "@/lib/claude-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Local-only: reads ~/.claude/projects. On Vercel (no access to the user's home) this returns [].
//
// `?ids=a,b` narrows the reply to those sessions. /glance (§23) needs three titles, and the full list
// is every session on the box (hundreds of KB) — over a phone's tailnet link on every refresh. The
// server-side cost is the same either way (listSessions is cached); only the payload shrinks.
export async function GET(req: Request) {
  try {
    const ids = new URL(req.url).searchParams.get("ids");
    const all = listSessions();
    if (!ids) return Response.json({ sessions: all });
    const want = new Set(ids.split(",").filter(Boolean));
    return Response.json({ sessions: all.filter((s) => want.has(s.id)) });
  } catch {
    return Response.json({ sessions: [] });
  }
}
