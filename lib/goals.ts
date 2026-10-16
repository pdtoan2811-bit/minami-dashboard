// Goals (§29): the autonomous goals the goal runner works on every morning, read for the /goals page.
//
// A goal is a ```json goal block inside a vault project note (`10-19 Projects/*.md`); the runner
// (`70-79 Toolshed/tools/goals/goal.mjs`, launchd com.thomas.goal-runner at 06:45) appends one line per run to
// ~/.minami/goals/<id>/log.jsonl and leaves Thomas's part for the day in today.json, which the 07:30 heartbeat
// adds to Today. This module only READS those files — the runner is the one writer, so the page can never
// disagree with what the runner will see tomorrow. Two actions: "run now" (a launchctl kickstart) and "resolve with
// Minami" (resolveGoal: the goal's context handed to a vault chat, which may write; this module still doesn't).
//
// The note is parsed here rather than by shelling out to `goal.mjs status`: the page polls, and a node spawn per
// poll per goal costs more than reading three small files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readDay, localDate } from "@/lib/today";

const HOME = os.homedir();
const VAULT = process.env.SECOND_BRAIN_DIR || path.join(HOME, "secondBrain");
const PROJECTS = path.join(VAULT, "10-19 Projects");
const STATE = process.env.MINAMI_GOALS_DIR || path.join(HOME, ".minami/goals");
const LABEL = "com.thomas.goal-runner";

export type GoalSpec = {
  id: string; goal: string; done_when: string; started?: string; deadline: string;
  target: { metric: string; queries: string[]; value: number; days: number };
  levers: Record<string, string>; never: string[]; escalate: string[];
  facts?: Record<string, unknown>; context?: string[];
};
/** A position: a number, null = Google showed the page and we weren't on it, "no reading" = the check failed. */
export type Position = number | null | "no reading";
export type GoalAction = {
  lever: string; queued?: string; opened?: string; merged?: boolean; pr?: string; note?: string;
  skipped?: string; waiting?: string; error?: string; refused_by_guard?: string; usd?: number | null;
};
export type GoalRun = {
  date: string; at: string; positions: Record<string, Position>;
  gsc: Record<string, { position: number; impressions: number; clicks: number } | null>;
  index: { indexed: number; total: number; failed?: number } | null;
  above?: Record<string, string[]>;
  decision: { assessment: string; on_track: boolean };
  todos: string[]; actions: GoalAction[]; usd: number | null;
};
export type GoalTodo = { text: string; why?: string; est_min?: number; done?: boolean };
export type GoalQuestion = { question: string; options: { label: string; description?: string }[] };
export type Goal = {
  spec: GoalSpec; note: string; daysLeft: number; log: GoalRun[];
  /** Thomas's part today, with the ticks from Today when the heartbeat has put them there. */
  today: { date: string; todos: GoalTodo[]; questions: GoalQuestion[] } | null;
  runner: { loaded: boolean; running: boolean; lastExit: number | null };
};

const readJSON = <T,>(f: string): T | null => { try { return JSON.parse(fs.readFileSync(f, "utf8")) as T; } catch { return null; } };
function jsonl<T>(f: string): T[] {
  try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } }); }
  catch { return []; }
}

function specs(): { spec: GoalSpec; note: string }[] {
  const out: { spec: GoalSpec; note: string }[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(PROJECTS).filter((f) => f.endsWith(".md")); } catch { return out; }
  for (const f of files) {
    const md = fs.readFileSync(path.join(PROJECTS, f), "utf8");
    const m = md.match(/```json goal\n([\s\S]*?)\n```/);
    if (!m) continue;
    // A goal block he is mid-way through editing is skipped, not fatal: the other goals still show.
    try { out.push({ spec: JSON.parse(m[1]) as GoalSpec, note: f.replace(/\.md$/, "") }); } catch { /* invalid JSON */ }
  }
  return out;
}

function runner(): Goal["runner"] {
  try {
    const out = execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${LABEL}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    const exit = out.match(/last exit code = (\d+)/);
    return { loaded: true, running: /state = running/.test(out), lastExit: exit ? Number(exit[1]) : null };
  } catch { return { loaded: false, running: false, lastExit: null }; }
}

export function listGoals(): Goal[] {
  const date = localDate();
  const day = readDay(date);
  const r = runner();
  return specs().map(({ spec, note }) => {
    const dir = path.join(STATE, spec.id);
    const t = readJSON<{ date: string; todos?: GoalTodo[]; loops?: GoalQuestion[] }>(path.join(dir, "today.json"));
    // The tick comes from Today, matched on the text the runner wrote (the heartbeat keeps it verbatim).
    const done = new Map(day.todos.filter((x) => (x as { goal?: string }).goal === spec.id).map((x) => [x.text, !!(x as { done?: boolean }).done]));
    const today = t && t.date === date
      ? { date, todos: (t.todos || []).map((x) => ({ ...x, done: done.get(x.text) ?? false })), questions: t.loops || [] }
      : null;
    return {
      spec, note, log: jsonl<GoalRun>(path.join(dir, "log.jsonl")), today, runner: r,
      daysLeft: Math.ceil((Date.parse(spec.deadline) - Date.parse(date)) / 864e5),
    };
  });
}

/** Run every goal now (the runner takes --all; there is one job, not one per goal). */
export function runGoalsNow() {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  execFileSync("launchctl", ["kickstart", `${domain}/${LABEL}`], { stdio: "ignore", timeout: 10_000 });
}

// ── "Resolve with Minami" (§29) ────────────────────────────────────────────────────────────────────────────
// The page can say a goal is stuck; this hands everything the page knows to a chat that can act on it. The chat
// runs in the vault, because the goal note, its drafts and the runner's code (70-79 Toolshed/tools/goals) all live
// there, and the runner's state dir is named in the message. One chat per goal per day: a second click sends the
// fresh context into the same conversation instead of opening a parallel one that would redo its work.
const RUNNER_CODE = path.join(VAULT, "70-79 Toolshed/tools/goals/goal.mjs");

function outcomeOf(a: GoalAction): string {
  if (a.refused_by_guard) return `REFUSED by the guard: ${a.refused_by_guard.trim()}`;
  if (a.error) return `FAILED: ${a.error}`;
  if (a.opened) return `opened PR ${a.opened}`;
  if (a.merged) return `merged ${a.pr ?? ""}`.trim();
  if (a.waiting) return `waiting: ${a.waiting}`;
  if (a.skipped) return `skipped: ${a.skipped}`;
  if (a.queued) return `queued "${a.queued}"`;
  if (a.note) return `drafted "${a.note}"`;
  return "no outcome recorded";
}

export function resolveContext(g: Goal): string {
  const q = g.spec.target.queries;
  const runs = g.log.slice(-6).map((r) => {
    const pos = q.map((x) => `"${x}" ${r.positions[x] == null ? "not on page 1" : r.positions[x]}`).join(", ");
    const acts = r.actions.length ? r.actions.map((a) => `    - ${a.lever}: ${outcomeOf(a)}${a.usd ? ` ($${a.usd.toFixed(2)})` : ""}`).join("\n") : "    - measured only";
    return `- ${r.date} ${r.at}: ${pos}; indexed ${r.index ? `${r.index.indexed}/${r.index.total}` : "?"}; ${r.decision.on_track ? "on track" : "behind"}\n${acts}`;
  }).join("\n");
  const asks = g.today ? [...g.today.todos.map((t) => `- [${t.done ? "x" : " "}] ${t.text}${t.why ? ` (why: ${t.why})` : ""}`),
    ...g.today.questions.map((x) => `- question: ${x.question}`)].join("\n") : "";
  const runner = !g.runner.loaded ? "NOT LOADED in launchd" : g.runner.running ? "running right now" : `loaded, last exit ${g.runner.lastExit ?? "unknown"}`;
  return [
    `Goal: ${g.spec.goal} (id ${g.spec.id}, note "10-19 Projects/${g.note}.md")`,
    `Done when: ${g.spec.done_when}. Deadline ${g.spec.deadline}, ${g.daysLeft} days left.`,
    `Latest assessment: ${g.log.at(-1)?.decision.assessment ?? "no run yet"}`,
    `Runner (launchd ${LABEL}): ${runner}. Code: ${RUNNER_CODE}. State and logs: ${path.join(STATE, g.spec.id)} and ${path.join(STATE, "runner.log")}.`,
    `Recent runs, oldest first:\n${runs || "- none"}`,
    asks ? `Thomas's part today:\n${asks}` : "Thomas's part today: nothing.",
    `Levers it may pull: ${Object.keys(g.spec.levers).join(", ")}. Never: ${g.spec.never.join("; ")}.`,
  ].join("\n\n");
}

export async function resolveGoal(id: string): Promise<{ sessionId: string }> {
  const g = listGoals().find((x) => x.spec.id === id);
  if (!g) throw new Error(`no goal ${id}`);
  const { sendMessage, liveStats } = await import("@/lib/agent/manager");
  const key = `goal:resolve:${id}:${localDate()}`;
  // The first line is the chat's name on the board (§5h).
  const message = `Goal · resolve ${g.note}\n\nThis autonomous goal is stuck or behind. Here is everything the dashboard knows about it:\n\n${resolveContext(g)}\n\n` +
    "Find what is blocking it and resolve what you can, in this order:\n" +
    "1. Anything broken in the machinery (a failed or refused action, a runner error): find the cause in the runner's code or logs and fix it. Then say whether it needs a re-run (don't kickstart it without asking: a run costs money and can open PRs).\n" +
    "2. Actions it queued that are stuck (an article never picked up, a PR waiting): find out why, and unblock them if that is within the goal's levers.\n" +
    "3. Thomas's part: do everything that doesn't need his login, his name or a click in a third-party UI, and prepare the rest (exact copy, exact URLs, the steps) so it takes him minutes.\n" +
    "Respect the goal's never-list. Never post as Thomas. Finish with: what you fixed, what is still waiting and on whom, and what he should do next.";
  let { sessionId } = sendMessage({ key, cwd: VAULT, message });
  for (let i = 0; !sessionId && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    sessionId = liveStats().details.find((d) => d.key === key)?.sessionId ?? null;
  }
  if (!sessionId) throw new Error("the chat didn't start in time — look for it on the board");
  return { sessionId };
}
