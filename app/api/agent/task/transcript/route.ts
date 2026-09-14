import { readSubagent } from "@/lib/claude-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/agent/task/transcript?sessionId=…&taskId=…[&toolUseId=…] → a subagent's own transcript.
//
// This is the "View transcript" link on a task card, and it reads the sidecar the read pipeline had
// never opened: `<session dir>/<sessionId>/subagents/agent-<taskId>.jsonl`. Works while the agent is
// still running (the file is appended live) and after — which is the point, since the parent
// transcript keeps only the Task tool's capped result once the turn ends.
//
// 404 is the honest answer for "not yet": a spawn is a second or two ahead of its first row on disk.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId") || "";
  const taskId = url.searchParams.get("taskId") || undefined;
  const toolUseId = url.searchParams.get("toolUseId") || undefined;
  if (!sessionId || (!taskId && !toolUseId)) return Response.json({ error: "sessionId and taskId (or toolUseId) required" }, { status: 400 });
  const page = readSubagent(sessionId, { taskId, toolUseId });
  if (!page) return Response.json({ error: "no transcript on disk for that task yet" }, { status: 404 });
  return Response.json(page);
}
