// Task records — what was assigned to whom, how it went, and which transcript it produced.
//
// One file, rewritten whole, rather than a file per task: unlike the registry these are written by a
// single in-process runner (never concurrently by several panes), they're read as a list on every
// roster paint, and the newest few are the only ones anyone looks at. A JSONL append log would avoid
// the rewrite but makes "mark this one done" a rewrite anyway.
//
// The write is atomic (tmp + rename) because the runner updates a task mid-run, and a torn file here
// loses every task's history — including the sessionId links that are the only thing tying an agent
// to the work it did in someone else's folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTask, AgentTaskStatus } from "./types";

export const TASKS_FILE =
  process.env.MINAMI_AGENT_TASKS || path.join(os.homedir(), ".minami", "agent-tasks.json");

// Enough to hold weeks of real use; the roster only ever renders the newest handful. Trimming from
// the front on write keeps the file bounded without a separate compaction step.
const MAX_TASKS = 500;

let cache: AgentTask[] | null = null;

function load(): AgentTask[] {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8"));
    cache = Array.isArray(raw) ? (raw as AgentTask[]) : [];
  } catch (e) {
    // ENOENT is the ordinary first-run case and says nothing. Anything else means there IS a file and
    // it could not be read — and since the next write replaces it wholesale, the old contents are
    // about to be gone for good. Take a copy and say so on the server log; an empty task list that
    // silently means "your history was unreadable" is indistinguishable from "you have no history".
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      const wreck = `${TASKS_FILE}.corrupt`;
      try { fs.copyFileSync(TASKS_FILE, wreck); } catch { /* best effort */ }
      console.error(`[agents] ${TASKS_FILE} is unreadable (${String((e as Error)?.message || e)}). A copy is at ${wreck}; starting from empty.`);
    }
    cache = [];
  }
  return cache!;
}

function persist(list: AgentTask[]): void {
  cache = list.slice(-MAX_TASKS);
  fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
  const tmp = `${TASKS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
  fs.renameSync(tmp, TASKS_FILE);
}

/** Newest first. `agentId` filters to one agent's runs, including ones handed to it by a peer. */
export function listTasks(agentId?: string): AgentTask[] {
  const all = load();
  const rows = agentId ? all.filter((t) => t.agentId === agentId) : all;
  return rows.slice().reverse();
}

export function getTask(id: string): AgentTask | null {
  return load().find((t) => t.id === id) || null;
}

export function addTask(t: AgentTask): AgentTask {
  persist([...load(), t]);
  return t;
}

export function patchTask(id: string, patch: Partial<AgentTask>): AgentTask | null {
  const list = load();
  const at = list.findIndex((t) => t.id === id);
  if (at < 0) return null;
  const next = { ...list[at], ...patch, id: list[at].id };
  const copy = list.slice();
  copy[at] = next;
  persist(copy);
  return next;
}

/**
 * Sessions this agent produced, as `{ sessionId → task }`. This is what makes work done in someone
 * else's folder attributable: a transcript in ~/ecomIntel carries no agent id, and several agents may
 * legitimately have run there, so the task record is the only honest link between the two.
 */
export function sessionOwners(agentId: string): Map<string, AgentTask> {
  const m = new Map<string, AgentTask>();
  for (const t of load()) {
    if (t.agentId === agentId && t.sessionId) m.set(t.sessionId, t);
  }
  return m;
}

/**
 * Anything left `running` or `queued` from a previous process is a lie: live sessions are children of
 * THIS server, so a restart (every deploy is one) killed them. Called once at module load on the
 * server so a roster never shows a task that's been dead since the last swap.
 */
export function reapOrphans(): number {
  const list = load();
  let n = 0;
  const next = list.map((t) => {
    if (t.status !== "running" && t.status !== "queued") return t;
    n++;
    return {
      ...t,
      status: "failed" as AgentTaskStatus,
      endedAt: Date.now(),
      error: "The dashboard restarted while this was running — live sessions don't survive a restart.",
    };
  });
  if (n) persist(next);
  return n;
}
