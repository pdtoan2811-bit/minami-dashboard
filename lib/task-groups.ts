// One row per TASK on the phone, not one per session (§23, 2026-10-09).
//
// Work here continues by starting a new session in the same worktree — "continue", "check progress",
// "go" — on purpose, as a new step of the same task (Thomas, interview 2026-10-09). Each of those is a
// separate transcript with its own AI title, so a list of sessions showed one task as three unrelated
// rows: ecvision/chat-14 was "Clean up frontend worktrees", "tracking multi-round post…" and "checking
// project milestone…", and two of the five focus slots went to two sessions of chat-4.
//
// The worktree is the task: `node bin/task.mjs new` and the pane's isolate path give every task its own
// checkout, so sessions sharing a `.minami-worktrees/<name>` cwd ARE one task. Chats in a main checkout
// stay one row each — there, two sessions in `~/ecvision` are usually two unrelated questions.
//
// The row stands for its most URGENT session (ties → newest), not its newest: a question waiting in
// yesterday's session must not hide behind today's idle one. Opening the row opens that session.
import type { Group, InboxSession } from "@/components/Inbox";

export const RANK: Record<Group, number> = { failed: 0, need: 1, running: 2, new: 3, idle: 4 };

export function taskKeyOf(cwd: string | undefined, id: string): string {
  return cwd && cwd.includes("/.minami-worktrees/") ? `wt:${cwd}` : `s:${id}`;
}

export type Task = {
  key: string;
  /** The session the row shows and opens. */
  rep: InboxSession;
  /** Every session of the task, newest first. */
  members: InboxSession[];
  g: Group;
  last: number;
};

export function groupTasks(sessions: InboxSession[], groups: Record<string, Group>): Task[] {
  const by = new Map<string, InboxSession[]>();
  for (const s of sessions) {
    const k = s.task || `s:${s.id}`;
    const a = by.get(k);
    if (a) a.push(s); else by.set(k, [s]);
  }
  const out: Task[] = [];
  for (const [key, ms] of by) {
    ms.sort((a, b) => b.lastActivity - a.lastActivity);
    const rep = [...ms].sort((a, b) => RANK[groups[a.id] ?? "idle"] - RANK[groups[b.id] ?? "idle"] || b.lastActivity - a.lastActivity)[0];
    out.push({ key, rep, members: ms, g: groups[rep.id] ?? "idle", last: ms[0].lastActivity });
  }
  return out;
}

export const byUrgency = (a: Task, b: Task) => RANK[a.g] - RANK[b.g] || b.last - a.last;
