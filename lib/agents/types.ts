// The shapes shared by the agent layer's server modules and its UI.
//
// The one idea worth stating once, here, because every other file assumes it: an agent is an
// IDENTITY plus a HOME FOLDER, and those are not the same as the folder it happens to be working in.
// `home` is where it thinks and remembers — its CLAUDE.md, its notes, its accumulated memory. It's
// stable for the agent's whole life. `workspaces` are the repos you let it go and do work in, and a
// run in a workspace still writes what it learned back to `home`. Collapsing the two (agent == cwd)
// is the obvious simplification and it's wrong: a Researcher that forgets everything the moment it
// steps into ~/ecomIntel is just a chat window with a name on it.
import type { AllowedMode } from "../agent/manager";

export type AgentDef = {
  /** Slug. Stable for the agent's life — it's in the session keys and the registry file name. */
  id: string;
  name: string;
  /** One line: what this agent owns. Shown on the tile, and seeded into its CLAUDE.md. */
  role: string;
  /** Emoji. Cheap, renders everywhere, no asset pipeline. */
  icon: string;
  /** Its brain: absolute path. Sessions started from the agent's own chat run here. */
  home: string;
  /** Absolute paths this agent may be assigned work in. `home` is always implicitly allowed. */
  workspaces: string[];
  /** Resolved model id. Defaults to the box pin — see lib/model-pins.ts, never a literal. */
  model: string;
  permissionMode: AllowedMode;
  /**
   * The one you talk to. HQ's scaffolded CLAUDE.md documents `bin/agent.mjs`, so it can assign work
   * to its peers and read their status — orchestration is a tool it holds, not a code path here.
   * Enforced unique by the store: promoting one agent demotes the rest.
   */
  hq: boolean;
  createdAt: number;
  /** True when we created `home`; false when an existing folder (e.g. ~/secondBrain) was adopted. */
  scaffolded: boolean;
  /** Set once the onboarding interview has been run, so the roster can nag about the ones that haven't. */
  onboardedAt?: number;
};

export type AgentTaskStatus = "queued" | "running" | "done" | "failed" | "stopped";

export type AgentTask = {
  id: string;
  agentId: string;
  title: string;
  brief: string;
  /** Which folder this run happens in — a workspace, or the agent's home. */
  cwd: string;
  status: AgentTaskStatus;
  /** The manager pane key this ran under: `agent:<agentId>:<taskId>`. */
  key: string;
  /**
   * The server process that started this run.
   *
   * Live sessions are children of that process, so a record whose pid isn't ours describes work that
   * is definitely dead — which is what `reapOrphans()` needs to know, and what it used to *assume*
   * from being at module load. See the post-mortem in §14.3.
   */
  pid?: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** Claude session id, once the SDK reports one. This is also what ties the run into the agent's history. */
  sessionId?: string | null;
  /** Agent id that created this task, when it came from a handoff rather than from you. */
  from?: string;
  /** Hand the result to this agent when the run finishes. Chains show up as a strip on the roster. */
  handoffTo?: string;
  /** Trailing slice of the final assistant message — enough to read on a tile without opening the run. */
  result?: string;
  error?: string;
};

/** What `POST /api/agents/:id/tasks` accepts. */
export type AssignInput = {
  title?: string;
  brief: string;
  cwd?: string;
  from?: string;
  handoffTo?: string;
};
