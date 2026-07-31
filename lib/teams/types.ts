// The shapes the team layer runs on.
//
// One idea to hold before reading any of it: a TEAM RUN is not a conversation. It's a sequence of
// ordinary unattended agent tasks (§14.3) that happen to share one document. Each stage is a separate
// session, in a separate folder, with its own memory and its own skills — the only thing that crosses
// the boundary between them is the dossier on disk. That's deliberate: a single chat that "pulls
// context from different folders" ends up with one context window holding five roles' worth of
// half-remembered detail, and no role does its own job well.
//
// So the chain is data (StageSpec[]), the roles are standing agents (§14.1), and the handoff is a file.
import type { AgentTaskStatus } from "../agents/types";

/**
 * One role in a template. Instantiating a template turns each of these into a real standing agent —
 * or reuses the one already living at `home`, which is how "the PM brain" stays a single brain across
 * every product on the box.
 */
export type RoleSpec = {
  /** Stable within a template, and the default folder name under the brains root. */
  key: string;
  name: string;
  icon: string;
  /** One line: what this role owns. Goes on the tile and into the persona's opening. */
  role: string;
  /**
   * Whether this role is given the product's workspace as an assignable folder.
   *
   * Not a formality — `assign()` enforces the workspace list (§14.3), so this is the difference
   * between a role that can touch the repo and one that works from the dossier alone. Roles that
   * don't need the code don't get it: a whitelist everyone is on describes nothing.
   */
  needsWorkspace: boolean;
  /** The role's CLAUDE.md, written on first instantiation only. Editable afterwards — it's their file. */
  persona: string;
  /** Procedures that load for any session in the role's home. */
  skills: { name: string; description: string; body: string }[];
};

/**
 * One step of the chain. Not one per role: the PM appears twice (it opens with acceptance criteria and
 * closes by checking against them), and a stage is the thing that varies, not the agent.
 */
export type StageSpec = {
  /** Unique within the template — it's the stage id in a run record. */
  key: string;
  /** Which role runs it. */
  role: string;
  /** The dossier heading this stage must write, verbatim. The runner checks the section landed. */
  section: string;
  /** What this stage is for, in the second person. Appended to the standard stage brief. */
  instruction: string;
};

export type TeamTemplate = {
  id: string;
  name: string;
  description: string;
  /** Ordered — this is also the order roles get created in. */
  roles: RoleSpec[];
  chain: StageSpec[];
};

/**
 * A product: a workspace, a team, and a record. The registry row is thin for the same reason the agent
 * registry is — the substance lives in the record folder, where every other tool on the box can read
 * it. What's here is only what the server needs to start a run.
 */
export type Product = {
  id: string;
  name: string;
  templateId: string;
  /** Absolute path to the repo this product's work happens in. Optional: a GTM-only product has none. */
  workspace?: string;
  /** Where the durable record lives. Curated by the closing stage, not by the runner. */
  recordPath: string;
  /** roleKey → agentId. Resolved at creation so a renamed template can't repoint a running product. */
  roles: Record<string, string>;
  createdAt: number;
  /**
   * Whether the closing stage may push the record to every device (`bin/sync.sh`).
   *
   * Off by default and deliberately so: an unattended run publishing to a synced vault is an outward
   * action nobody watched happen. Opt in per product once you trust what the team writes.
   */
  sync: boolean;
};

export type RunStageStatus = "pending" | "running" | AgentTaskStatus;

export type RunStage = {
  key: string;
  role: string;
  section: string;
  agentId: string;
  /** The agent task this stage ran as — the link to the transcript, the activity log and the history tab. */
  taskId?: string;
  status: RunStageStatus;
  startedAt?: number;
  endedAt?: number;
  /**
   * Did the agent's section actually appear in the dossier?
   *
   * Recorded rather than assumed. A stage can finish successfully and write nothing — the model
   * decided to summarise in chat instead — and the next stage then reads a document with a hole in it.
   * Better to see the hole on the run page than to wonder why the closing verdict makes no sense.
   */
  appended?: boolean;
  error?: string;
};

export type TeamRunStatus = "running" | "done" | "failed" | "stopped";

export type TeamRun = {
  id: string;
  productId: string;
  productName: string;
  templateId: string;
  title: string;
  brief: string;
  stages: RunStage[];
  status: TeamRunStatus;
  createdAt: number;
  endedAt?: number;
  error?: string;
  /** The server process driving this run. See `reapOrphanRuns()` and the same field on `AgentTask`. */
  pid?: number;
};
