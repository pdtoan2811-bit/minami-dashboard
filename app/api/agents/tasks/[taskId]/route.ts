import { stopTask } from "@/lib/agents/runner";
import { getTask } from "@/lib/agents/tasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const task = getTask(taskId);
  if (!task) return Response.json({ error: "no such task" }, { status: 404 });
  return Response.json({ task });
}

/** Interrupt a run. The task closes as `stopped`, which is not `failed` — you ended it, it didn't break. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const ok = await stopTask(taskId);
  return Response.json({ ok, task: getTask(taskId) });
}
