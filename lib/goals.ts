// Goals (§29): the autonomous goals the goal runner works on every morning, read for the /goals page.
//
// A goal is a ```json goal block inside a vault project note (`10-19 Projects/*.md`); the runner
// (`70-79 Toolshed/tools/goals/goal.mjs`, launchd com.thomas.goal-runner at 06:45) appends one line per run to
// ~/.minami/goals/<id>/log.jsonl and leaves Thomas's part for the day in today.json, which the 07:30 heartbeat
// adds to Today. This module only READS those files — the runner is the one writer, so the page can never
// disagree with what the runner will see tomorrow. The one action is "run now" (a launchctl kickstart).
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
