// Turning a template's roles into real standing agents, and keeping each one's brain in git.
//
// The rule this file exists to enforce: **a role is one brain, box-wide**. Instantiating the
// tech-product template twice must not produce two PMs — it must find the PM already living at
// ~/brains/pm and reuse it, so the craft that agent accumulates compounds across every product
// instead of being re-learned per project. Which is also why the product-specific memory goes in the
// record (see §15.3), not in the role's MEMORY.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffold } from "../agents/scaffold";
import { agentAtHome, createAgent, DASHBOARD_URL, updateAgent } from "../agents/store";
import type { AgentDef } from "../agents/types";
import type { RoleSpec } from "./types";

/** Where role brains live. One folder per role, shared by every product that uses that role. */
export const BRAINS_ROOT = process.env.MINAMI_BRAINS_DIR || path.join(os.homedir(), "brains");

export function homeForRole(key: string): string {
  return path.join(BRAINS_ROOT, key);
}

function git(home: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", home, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

/**
 * Make a role's home a git repo, unless it's already inside one.
 *
 * The `already inside one` check is not defensive padding — an adopted brain can easily be a folder
 * within ~/secondBrain, and `git init` there would create a nested repository that the outer repo
 * then sees as an opaque, uncommittable blob. Silently, and only noticed weeks later when the vault's
 * history has a hole in it.
 */
export function ensureBrainRepo(home: string): boolean {
  if (git(home, ["rev-parse", "--show-toplevel"])) return false;
  if (!git(home, ["init", "-q"])) return false;
  git(home, ["add", "-A"]);
  git(home, ["commit", "-q", "-m", "brain: scaffolded"]);
  return true;
}

/**
 * Commit whatever the agent changed about itself.
 *
 * Agents may rewrite their own persona and skills after a run (that was the explicit choice: compound
 * fastest, stay revertible). Without a commit per run, "the QA got worse last week" is unanswerable —
 * with one, it's a diff. Best-effort throughout: a brain that isn't a repo, or a commit with nothing
 * to commit, must never fail the run that already happened.
 */
export function commitBrain(home: string, message: string): void {
  if (!git(home, ["rev-parse", "--git-dir"])) return;
  git(home, ["add", "-A"]);
  git(home, ["commit", "-q", "-m", message]);
}

/**
 * The agent for a role — reused if it exists, created and scaffolded if not.
 *
 * Reuse is keyed on the HOME FOLDER, not on the name or the id. That's the same key
 * `agentAtHome()` guards uniqueness with (§14.2), so this can't produce a state that route would
 * refuse: if something already lives at ~/brains/pm, it *is* the PM, whatever it happens to be called.
 */
export function ensureRoleAgent(spec: RoleSpec): { agent: AgentDef; created: boolean } {
  const home = homeForRole(spec.key);
  const existing = agentAtHome(home);
  if (existing) return { agent: existing, created: false };

  const agent = createAgent({
    id: spec.key,
    name: spec.name,
    role: spec.role,
    icon: spec.icon,
    home,
    workspaces: [],
    scaffolded: true,
  });
  scaffold(agent, { dashboardUrl: DASHBOARD_URL, persona: spec.persona, skills: spec.skills });
  ensureBrainRepo(agent.home);
  return { agent, created: true };
}

/**
 * Let a role work in a product's workspace.
 *
 * `assign()` enforces the workspace list, so this is what makes a stage runnable there at all — and
 * the reason only roles with `needsWorkspace` get it. Additive and idempotent: a role picks up
 * workspaces as it's put on more products, and never loses one when a product is deleted, because
 * another product may still be using it.
 */
export function grantWorkspace(agent: AgentDef, workspace: string): AgentDef {
  let resolved = workspace;
  try { resolved = fs.realpathSync(workspace); } catch { /* the caller has already checked it exists */ }
  if (agent.home === resolved || agent.workspaces.includes(resolved)) return agent;
  return updateAgent(agent.id, { workspaces: [...agent.workspaces, resolved] }) || agent;
}
