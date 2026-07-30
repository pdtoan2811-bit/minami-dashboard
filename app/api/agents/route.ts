import { liveStats } from "@/lib/agent/manager";
import { chatKey, taskKey } from "@/lib/agents/runner";
import { inspect, scaffold } from "@/lib/agents/scaffold";
import { agentAtHome, brokenAgentFiles, createAgent, DASHBOARD_URL, expandHome, isPlausibleModel, listAgents } from "@/lib/agents/store";
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
      // ALL of them, not the first. An agent can legitimately be running several assigned tasks at
      // once (nothing serialises them), and reporting one made the other invisible — the tile showed
      // "↻ B" while A was running too, so a box with four live subprocesses looked like one.
      const running = tasks.filter(
        (t) => t.agentId === a.id && t.status === "running" && live.some((d) => d.key === taskKey(a.id, t.id)),
      );
      const recent = tasks.filter((t) => t.agentId === a.id).slice(0, 3);
      return {
        ...a,
        live: mine.length > 0,
        busy: !!busy,
        phase: busy?.phase || mine[0]?.phase || "idle",
        label: busy?.label || "",
        // Only tasks the manager can still see — see the note above.
        runningTask: running[0] || null,
        runningCount: running.length,
        recentTasks: recent,
      };
    });
    // The roster's "Recent work" strip used to re-fetch every agent's tasks separately, which is an
    // N+1 on a 4s poll — eleven agents meant ~24 requests every nine seconds, each one re-reading and
    // re-parsing the whole task file. They're already in hand here, so send them.
    return Response.json({ agents: rows, recent: tasks.slice(0, 12), broken: brokenAgentFiles() });
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
    // Expanded through the same helper the inspect route uses, so the folder the dialog reported on
    // is exactly the folder that gets created — see expandHome().
    const home = expandHome(String(body?.home || ""));
    if (!name) return Response.json({ error: "name is required" }, { status: 400 });
    if (!home || !path.isAbsolute(home)) return Response.json({ error: "home must be an absolute path" }, { status: 400 });
    if (body?.model !== undefined && !isPlausibleModel(String(body.model))) {
      return Response.json({ error: `not a Claude model id: ${body.model}` }, { status: 400 });
    }

    const before = inspect(home, PROJECTS);
    if (before.exists && !before.isDir) return Response.json({ error: `not a folder: ${home}` }, { status: 400 });
    const squatter = agentAtHome(home);
    if (squatter) {
      return Response.json({
        error: `${squatter.name} already lives in ${home}. Two agents can't share one home — they'd claim each other's history and write over each other's memory.`,
      }, { status: 409 });
    }

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
    // The note structure is imposed only on a brain we are CREATING, or on a folder already shaped
    // that way. Adopting a code repo used to litter it with four empty vault directories
    // ("00-09 System/", "10-19 Projects/", …) that nothing in that project wanted — and in a git repo
    // they show up as untracked noise on the user's next status. An adopted folder keeps its own
    // shape; what an agent actually needs from it is CLAUDE.md and somewhere to write memory, and
    // both of those are written either way.
    const notes = before.suggests === "scaffold" || before.hasNotes;
    const result = scaffold(agent, { dashboardUrl: DASHBOARD_URL, notes });
    return Response.json({ ok: true, agent, scaffold: result, adopted: before.suggests === "adopt" });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
