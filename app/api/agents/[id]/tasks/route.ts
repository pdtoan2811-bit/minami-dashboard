import { assign } from "@/lib/agents/runner";
import { getAgent } from "@/lib/agents/store";
import { listTasks } from "@/lib/agents/tasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return Response.json({ tasks: listTasks(id) });
}

/**
 * Assign work. Returns as soon as the run is dispatched, never when it finishes — a task is minutes
 * of work and this is the endpoint HQ calls from a Bash tool inside its own turn. Blocking here would
 * make one agent's turn hostage to another's, and nested indefinitely once a handoff chains.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const agent = getAgent(id);
    if (!agent) return Response.json({ error: "no such agent" }, { status: 404 });
    const body = await req.json();
    const brief = String(body?.brief || "").trim();
    if (!brief) return Response.json({ error: "brief is required" }, { status: 400 });
    if (body?.handoffTo && !getAgent(String(body.handoffTo))) {
      // Checked now rather than at handoff time: a chain that silently drops its second half looks
      // exactly like a chain that ran, and the discovery is half an hour later.
      return Response.json({ error: `no such agent to hand off to: ${body.handoffTo}` }, { status: 400 });
    }
    const task = assign(agent, {
      title: typeof body?.title === "string" ? body.title : undefined,
      brief,
      cwd: typeof body?.cwd === "string" ? body.cwd : undefined,
      from: typeof body?.from === "string" ? body.from : undefined,
      handoffTo: typeof body?.handoffTo === "string" ? body.handoffTo : undefined,
    });
    return Response.json({ ok: true, task });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 400 });
  }
}
