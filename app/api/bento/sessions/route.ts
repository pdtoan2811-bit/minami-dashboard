import { listSessions } from "@/lib/claude-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Local-only: reads ~/.claude/projects. On Vercel (no access to the user's home) this returns [].
export async function GET() {
  try {
    return Response.json({ sessions: listSessions() });
  } catch {
    return Response.json({ sessions: [] });
  }
}
