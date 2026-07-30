import { safeMode } from "@/lib/agent/manager";
import { agentStats } from "@/lib/agents/history";
import { ensureHQSection, inspect } from "@/lib/agents/scaffold";
import { agentAtHome, DASHBOARD_URL, deleteAgent, expandHome, getAgent, isPlausibleModel, updateAgent } from "@/lib/agents/store";
import { listTasks } from "@/lib/agents/tasks";
import type { AgentDef } from "@/lib/agents/types";
import fs from "node:fs";
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
      const home = expandHome(String(patch.home));
      patch.home = home;
      if (!path.isAbsolute(home)) return Response.json({ error: "home must be an absolute path" }, { status: 400 });
      const rep = inspect(home, PROJECTS);
      // Moving an agent's home moves its memory and its history in one edit — so the target has to
      // actually be a folder. Nothing is copied: the old folder is left intact, because silently
      // relocating someone's notes is not something a config form should do.
      if (!rep.exists || !rep.isDir) return Response.json({ error: `folder does not exist: ${home}` }, { status: 400 });
      const squatter = agentAtHome(home, id);
      if (squatter) return Response.json({ error: `${squatter.name} already lives in ${home} — two agents can't share one home.` }, { status: 409 });
    }
    if (patch.model !== undefined && !isPlausibleModel(String(patch.model))) {
      return Response.json({ error: `not a Claude model id: ${patch.model}` }, { status: 400 });
    }
    // Rejected rather than coerced. safeMode() quietly maps anything unrecognised to "default", which
    // for an agent is the one mode that makes unattended tasks impossible — it prompts on every tool
    // and nobody is watching to answer. Silently choosing that on a typo is worse than a 400.
    if (patch.permissionMode !== undefined && safeMode(String(patch.permissionMode)) !== patch.permissionMode) {
      return Response.json({ error: `unknown approval level: ${patch.permissionMode}` }, { status: 400 });
    }
    if (patch.workspaces !== undefined) {
      if (!Array.isArray(patch.workspaces)) return Response.json({ error: "workspaces must be a list of absolute paths" }, { status: 400 });
      // Home is checked for existence and workspaces were not, so a deleted or mistyped folder sat in
      // the list looking assignable and failed only at assign time.
      const missing = patch.workspaces.map((w) => expandHome(String(w))).filter((w) => !inspect(w, PROJECTS).isDir);
      if (missing.length) return Response.json({ error: `not a folder: ${missing.join(", ")}` }, { status: 400 });
      patch.workspaces = patch.workspaces.map((w) => expandHome(String(w)));
    }

    const next = updateAgent(id, patch);
    if (!next) return Response.json({ error: "no such agent" }, { status: 404 });
    // Promotion has to reach the persona, not just the registry — an agent that's HQ on the roster but
    // whose CLAUDE.md never told it how to delegate will simply do everything itself. When there's no
    // CLAUDE.md to append to, say so instead of returning a silent success: the roster would show the
    // HQ badge while the agent had never been told it was HQ.
    if (patch.hq === true && !ensureHQSection(next, DASHBOARD_URL) && !fs.existsSync(path.join(next.home, "CLAUDE.md"))) {
      return Response.json({ ok: true, agent: next, warning: `${next.home}/CLAUDE.md is missing, so the delegation commands couldn't be written. Re-run the interview to rebuild it.` });
    }
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
