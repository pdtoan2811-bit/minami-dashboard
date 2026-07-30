// Running an assigned task: spawn it, watch it, harvest the result, make the agent write back, and
// hand off if a chain was requested.
//
// ── Why this polls instead of subscribing ─────────────────────────────────────────────────────────
// manager.ts exports subscribe(), which is the obvious way to learn a turn ended. Using it here would
// be a bug. A subscriber counts as a connected client, and two of the manager's safety behaviours key
// off `subs.size === 0`: the idle reaper, and the backstop that auto-denies a prompt nobody is left to
// answer (`scheduleIdle`). An unattended task has, by definition, nobody to answer prompts — so a
// server-side subscriber would suppress the exact rescue that keeps a parked run from pinning `busy`
// true forever, and a pinned `busy` starves every deploy on the box, not just this task.
//
// So the runner stays outside: it polls isBusy()/liveActivity(), which observe without participating.
import { isBusy, liveActivity, liveStats, sendMessage, stop } from "../agent/manager";
import { getSession } from "../claude-sessions";
import { taskPrompt, wrapUpPrompt } from "./onboard";
import { activityFileFor } from "./scaffold";
import { allowedCwds, getAgent } from "./store";
import { addTask, getTask, listTasks, patchTask, reapOrphans } from "./tasks";
import type { AgentDef, AgentTask, AssignInput } from "./types";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const POLL_MS = 2_000;

// How long to wait for a freshly-sent task to actually go busy. The SDK cold start is ~1-2s; this is
// generous because a box under load (several panes spawning at once) can take much longer, and the
// cost of being wrong here is declaring a run dead while its subprocess is still booting.
const SPAWN_GRACE_MS = 90_000;

// A whole run's ceiling. Long, because real work is long — but finite, because an unattended run that
// never ends is indistinguishable from a hung one and holds `busy` either way.
const MAX_RUN_MS = Math.max(60_000, Number(process.env.MINAMI_AGENT_TASK_TIMEOUT_MS) || 30 * 60 * 1000);

// How long a run may sit at phase `awaiting` before we kill it. The manager's own backstop handles
// this too, but only after IDLE_REAP_MS (30 min by default) — half an hour of `busy` that no deploy
// on the box can get past. An unattended run is told it cannot ask questions (see taskPrompt); if it
// asks anyway, that's a stall, and a stall should end in minutes, not in half an hour.
const AWAIT_LIMIT_MS = Math.max(30_000, Number(process.env.MINAMI_AGENT_AWAIT_LIMIT_MS) || 3 * 60 * 1000);

// Trailing slice of the final message kept on the task record — enough to read on a tile and enough
// to hand to the next agent in a chain, without turning the task file into a transcript store.
const RESULT_CHARS = 4_000;

/** Session key for a task run. The `agent:` prefix is what ties a live pane back to its owner. */
export function taskKey(agentId: string, taskId: string): string {
  return `agent:${agentId}:${taskId}`;
}

/** Session key for an agent's own chat — one per agent, so its pane survives navigation. */
export function chatKey(agentId: string): string {
  return `agent:${agentId}:chat`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The live session id the manager has bound to this key, once it exists. */
function sessionIdFor(key: string): string | null {
  return liveStats().details.find((d) => d.key === key)?.sessionId || null;
}

/** Final assistant text from the on-disk transcript — the authoritative copy, not a streamed guess. */
function harvest(sessionId: string | null): string {
  if (!sessionId) return "";
  try {
    const page = getSession(sessionId);
    for (let i = page.turns.length - 1; i >= 0; i--) {
      const t = page.turns[i];
      if (t.role === "assistant" && t.text.trim()) return t.text.trim().slice(-RESULT_CHARS);
    }
  } catch { /* transcript not readable yet — the task still completed */ }
  return "";
}

/**
 * Mechanical half of the write-back. Runs regardless of what the agent did or didn't write itself,
 * which is the point: the semantic wrap-up is a turn that can fail, be interrupted, or be skipped by
 * a model having a bad day, and an activity log with holes in it is worse than useless for answering
 * "what has this agent actually been doing".
 */
function logActivity(a: AgentDef, t: AgentTask, outcome: string): void {
  const file = path.join(a.home, activityFileFor(a.home));
  const when = new Date(t.endedAt || Date.now()).toISOString().slice(0, 16).replace("T", " ");
  const where = t.cwd === a.home ? "home" : t.cwd;
  const line = `- ${when} — **${t.title}** · ${where} · ${outcome}${t.from ? ` · from ${t.from}` : ""}\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
  } catch { /* an unwritable home shouldn't fail the run that already happened */ }
}

/** Wait for one turn on `key` to finish. Returns why it stopped. */
async function awaitTurn(key: string, deadline: number): Promise<"done" | "timeout" | "stalled" | "never-started"> {
  let sawBusy = false;
  const spawnBy = Date.now() + SPAWN_GRACE_MS;
  let awaitingSince = 0;

  for (;;) {
    await sleep(POLL_MS);
    const busy = isBusy(key);
    if (busy) sawBusy = true;

    if (!sawBusy) {
      // Still cold. A key that never goes busy AND never appears in liveStats never spawned at all.
      if (Date.now() > spawnBy) return "never-started";
      continue;
    }
    if (!busy) return "done";

    if (Date.now() > deadline) { await stop(key).catch(() => {}); return "timeout"; }

    // Parked on a prompt nobody will answer — see AWAIT_LIMIT_MS.
    const sid = sessionIdFor(key);
    const phase = sid ? liveActivity()[sid]?.phase : undefined;
    if (phase === "awaiting") {
      if (!awaitingSince) awaitingSince = Date.now();
      else if (Date.now() - awaitingSince > AWAIT_LIMIT_MS) { await stop(key).catch(() => {}); return "stalled"; }
    } else awaitingSince = 0;
  }
}

/**
 * Drive one task to completion in the background. Never throws at its caller — assign() returns as
 * soon as the run is dispatched, so anything that goes wrong here has to land on the task record
 * where it can actually be read.
 */
async function drive(a: AgentDef, task: AgentTask): Promise<void> {
  const key = task.key;
  const deadline = Date.now() + MAX_RUN_MS;

  const finish = (status: AgentTask["status"], patch: Partial<AgentTask>, outcome: string) => {
    const t = patchTask(task.id, { ...patch, status, endedAt: Date.now() }) || task;
    logActivity(a, t, outcome);
    return t;
  };

  try {
    const why = await awaitTurn(key, deadline);
    const sessionId = sessionIdFor(key) || task.sessionId || null;
    if (sessionId && sessionId !== task.sessionId) patchTask(task.id, { sessionId });

    // Did a human end this run while we were watching? `stopTask` interrupts the turn, which makes
    // `busy` go false — indistinguishable from a natural finish from inside awaitTurn(). Without this
    // check the run was reported as a SUCCESS: the status flipped from `stopped` back to `done`, the
    // activity log recorded "done" directly beneath the agent's own note saying it was interrupted,
    // and the "result" harvested from the transcript was whatever the agent had said before doing any
    // work ("I'll count from 1 to 40..."), which reads exactly like a completed summary. Worse, the
    // wrap-up below was then sent into the session you had just stopped, so it started working again.
    // The task record is the only place that knows a stop happened, so it is what gets consulted.
    const current = getTask(task.id);
    if (current?.status === "stopped") {
      logActivity(a, current, "stopped by you");
      return;
    }

    if (why !== "done") {
      const error = {
        timeout: `Ran past the ${Math.round(MAX_RUN_MS / 60000)}-minute limit and was stopped.`,
        stalled: "Stopped: it asked a question, and an unattended run has nobody to answer.",
        "never-started": "The session never started — check the folder exists and the CLI is logged in.",
      }[why];
      finish("failed", { sessionId, error }, why === "timeout" ? "timed out" : "failed");
      return;
    }

    const result = harvest(sessionId);
    patchTask(task.id, { sessionId, result });

    // ── the write-back ────────────────────────────────────────────────────────────────────────────
    // Its own turn, deliberately (see wrapUpPrompt). Failing it must NOT fail the task: the work is
    // already done and recorded, and marking a successful run failed because its memory note didn't
    // land would be actively misleading.
    try {
      sendMessage({ key, cwd: task.cwd, message: wrapUpPrompt(a, task.cwd, task.title), mode: a.permissionMode, model: a.model });
      await awaitTurn(key, Date.now() + Math.min(MAX_RUN_MS, 10 * 60 * 1000));
    } catch { /* the run stands; only its memory note is missing */ }

    // Re-checked, because the wrap-up is a whole turn during which Stop is still on screen.
    if (getTask(task.id)?.status === "stopped") { logActivity(a, task, "stopped by you"); return; }

    const done = finish("done", { sessionId, result }, "done");

    // ── handoff ───────────────────────────────────────────────────────────────────────────────────
    // Chained AFTER the write-back so the next agent starts against an agent whose memory is current.
    if (done.handoffTo) {
      const next = getAgent(done.handoffTo);
      if (next) {
        assign(next, {
          title: `Follow-up: ${done.title}`,
          brief: `**${a.name}** finished this task and handed the result to you:\n\n> ${done.title}\n\n---\n\n${result || "(it produced no summary)"}\n\n---\n\nCarry it forward from here.`,
          from: a.id,
        });
      } else {
        patchTask(done.id, { error: `Handoff target "${done.handoffTo}" no longer exists.` });
      }
    }
  } catch (e) {
    finish("failed", { error: String((e as Error)?.message || e) }, "failed");
  }
}

/**
 * Assign work. Returns the moment the run is dispatched — the task record is how you follow it, which
 * is what makes this usable from HQ (which can't sit and wait) and from a fetch that must not hang.
 */
export function assign(a: AgentDef, input: AssignInput): AgentTask {
  // Resolved before the check, because the stored home/workspaces are resolved too (see resolvePath
  // in the store) — comparing a caller's `/tmp/x` against a stored `/private/tmp/x` would refuse a
  // folder the agent is plainly allowed to work in.
  let cwd = input.cwd || a.home;
  try { cwd = fs.realpathSync(cwd); } catch { /* missing — caught by the stat below */ }
  // A workspace list that isn't enforced is decoration. This is the check that makes "assignable
  // workspaces" mean something — otherwise any caller could point any agent at any folder on the box.
  if (!allowedCwds(a).includes(cwd)) {
    throw new Error(`${a.name} isn't allowed to work in ${cwd}. Add it to the agent's workspaces first.`);
  }
  let st: fs.Stats | null = null;
  try { st = fs.statSync(cwd); } catch { /* reported below */ }
  if (!st?.isDirectory()) throw new Error(`folder does not exist: ${cwd}`);

  const id = randomUUID().slice(0, 8);
  const title = (input.title || input.brief).trim().split("\n")[0].slice(0, 80) || "Untitled task";
  const task = addTask({
    id, agentId: a.id, title, brief: input.brief, cwd,
    status: "running", key: taskKey(a.id, id),
    createdAt: Date.now(), startedAt: Date.now(),
    from: input.from, handoffTo: input.handoffTo,
  });

  sendMessage({
    key: task.key, cwd,
    message: taskPrompt(a, { title, brief: input.brief, cwd, from: input.from ? (getAgent(input.from)?.name || input.from) : undefined }),
    mode: a.permissionMode,
    model: a.model,
  });

  void drive(a, task);
  return task;
}

/** Stop a run in flight. The task record is closed here rather than by drive(), which is watching. */
export async function stopTask(taskId: string): Promise<boolean> {
  const t = listTasks().find((x) => x.id === taskId);
  if (!t || (t.status !== "running" && t.status !== "queued")) return false;
  await stop(t.key).catch(() => {});
  patchTask(taskId, { status: "stopped", endedAt: Date.now() });
  return true;
}

// Close out anything the last process left mid-flight. Import-time on purpose: every route that can
// show a task imports this module, so the roster is honest from the first paint after a restart
// rather than from whenever someone happens to open a task.
reapOrphans();
