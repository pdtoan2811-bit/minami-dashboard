import { stopTask } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { key, taskId } → stop ONE subagent or backgrounded command, leaving the turn running.
// The tasks panel's per-card ■. The pane's Stop button is a different route (/api/agent/stop) and a
// different thing: it interrupts the whole query.
export async function POST(req: Request) {
  try {
    const { key, taskId } = await req.json();
    if (!key || typeof taskId !== "string" || !taskId) return Response.json({ error: "key and taskId required" }, { status: 400 });
    return Response.json(await stopTask(key, taskId));
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
