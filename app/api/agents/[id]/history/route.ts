import { agentHistory } from "@/lib/agents/history";
import { getAgent } from "@/lib/agents/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → every session attributable to this agent, newest first. Sessions in its home folder are all
// its own; sessions elsewhere only count when a task record ties them to it. See lib/agents/history.ts.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const agent = getAgent(id);
    if (!agent) return Response.json({ error: "no such agent", sessions: [] }, { status: 404 });
    return Response.json({ sessions: agentHistory(agent) });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e), sessions: [] }, { status: 500 });
  }
}
