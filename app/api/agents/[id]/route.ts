import { agentStats } from "@/lib/agents/history";
import { ensureHQSection, inspect } from "@/lib/agents/scaffold";
import { DASHBOARD_URL, deleteAgent, getAgent, updateAgent } from "@/lib/agents/store";
import { listTasks } from "@/lib/agents/tasks";
import type { AgentDef } from "@/lib/agents/types";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = getAgent(id);
  if (!agent) return Response.json({ error: "no such agent" }, { status: 404 });
  return Response.json({
    agent,
    stats: agentStats(agent),
    home: inspect(agent.home, PROJECTS),
    tasks: listTasks(id).slice(0, 25),
  });
}

// Whitelisted, like the autopilot switch: these files are read by a process that spawns subprocesses
// with a cwd and a permission mode, so an unexpected key from a future client must not become config
// it silently obeys.
const PATCHABLE = ["name", "role", "icon", "home", "workspaces", "model", "permissionMode", "hq", "onboardedAt"] as const;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await req.json();
    const patch: Partial<AgentDef> = {};
    for (const k of PATCHABLE) if (k in body) (patch as Record<string, unknown>)[k] = body[k];

    if (patch.home !== undefined) {
      const home = String(patch.home);
      if (!path.isAbsolute(home)) return Response.json({ error: "home must be an absolute path" }, { status: 400 });
      const rep = inspect(home, PROJECTS);
      // Moving an agent's home moves its memory and its history in one edit — so the target has to
      // actually be a folder. Nothing is copied: the old folder is left intact, because silently
      // relocating someone's notes is not something a config form should do.
      if (!rep.exists || !rep.isDir) return Response.json({ error: `folder does not exist: ${home}` }, { status: 400 });
    }

    const next = updateAgent(id, patch);
    if (!next) return Response.json({ error: "no such agent" }, { status: 404 });
    // Promotion has to reach the persona, not just the registry — an agent that's HQ on the roster but
    // whose CLAUDE.md never told it how to delegate will simply do everything itself.
    if (patch.hq === true) ensureHQSection(next, DASHBOARD_URL);
    return Response.json({ ok: true, agent: next });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

/** Removes the roster entry only. The home folder — the actual work — is never touched; see the store. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = getAgent(id);
  if (!agent) return Response.json({ error: "no such agent" }, { status: 404 });
  deleteAgent(id);
  return Response.json({ ok: true, keptFolder: agent.home });
}
