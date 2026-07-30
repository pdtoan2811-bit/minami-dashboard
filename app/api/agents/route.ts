import { liveStats } from "@/lib/agent/manager";
import { chatKey, taskKey } from "@/lib/agents/runner";
import { inspect, scaffold } from "@/lib/agents/scaffold";
import { createAgent, DASHBOARD_URL, listAgents } from "@/lib/agents/store";
import { listTasks } from "@/lib/agents/tasks";
import type { AgentDef } from "@/lib/agents/types";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

/**
 * The roster, each agent joined to what it's doing right now.
 *
 * Live state comes from the manager rather than from the task file, because the task file records
 * intent and the manager records fact — a run whose subprocess died is `running` on disk and absent
 * here, and the tile should show the truth. Same REPLACE-semantics reasoning as the bento grid: the
 * server decides what's live, the client never derives it.
 */
export async function GET() {
  try {
    const agents = listAgents();
    const live = liveStats().details;
    const tasks = listTasks();
    const rows = agents.map((a) => {
      const mine = live.filter((d) => d.key === chatKey(a.id) || d.key.startsWith(`agent:${a.id}:`));
      const busy = mine.find((d) => d.busy) || null;
      const running = tasks.find((t) => t.agentId === a.id && t.status === "running") || null;
      const recent = tasks.filter((t) => t.agentId === a.id).slice(0, 3);
      return {
        ...a,
        live: mine.length > 0,
        busy: !!busy,
        phase: busy?.phase || mine[0]?.phase || "idle",
        label: busy?.label || "",
        // Only report a running task the manager can still see — see the note above.
        runningTask: running && live.some((d) => d.key === taskKey(a.id, running.id)) ? running : null,
        recentTasks: recent,
      };
    });
    return Response.json({ agents: rows });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e), agents: [] }, { status: 500 });
  }
}

/**
 * Create an agent, and give it a brain in the same call.
 *
 * Registry entry and folder are written together on purpose: an agent whose home doesn't exist yet is
 * a row that fails the moment anyone talks to it, and splitting the two across two requests means
 * every failure mode leaves one of them orphaned. scaffold() only ever fills gaps, so pointing this
 * at an existing folder is safe — that's the adopt path, and it's the same code.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const name = String(body?.name || "").trim();
    const home = String(body?.home || "").trim();
    if (!name) return Response.json({ error: "name is required" }, { status: 400 });
    if (!home || !path.isAbsolute(home)) return Response.json({ error: "home must be an absolute path" }, { status: 400 });

    const before = inspect(home, PROJECTS);
    if (before.exists && !before.isDir) return Response.json({ error: `not a folder: ${home}` }, { status: 400 });

    const draft: Partial<AgentDef> & { name: string; home: string } = {
      name, home,
      role: typeof body?.role === "string" ? body.role : "",
      icon: typeof body?.icon === "string" ? body.icon : undefined,
      workspaces: Array.isArray(body?.workspaces) ? body.workspaces : [],
      model: typeof body?.model === "string" ? body.model : undefined,
      permissionMode: body?.permissionMode,
      hq: body?.hq === true,
      // Records how this agent came to be, which is why the flag is immutable afterwards: "we made
      // this folder" and "we were pointed at someone's vault" imply different care when deleting.
      scaffolded: !before.exists || before.entries === 0,
    };

    const agent = createAgent(draft);
    const result = scaffold(agent, { dashboardUrl: DASHBOARD_URL });
    return Response.json({ ok: true, agent, scaffold: result, adopted: before.suggests === "adopt" });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
