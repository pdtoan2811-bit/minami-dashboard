// A task's chat reports its own progress (§37). Until this, every tick, every "on now" and every close
// was Minami (Haiku) reading the last ~7k characters of a quiet chat after the fact — late, a call per
// check, and wrong in ways that needed evidence quotes to catch. The chat doing the work already knows
// which item it just finished; this gives it a way to say so.
//
// Two surfaces, one implementation: the in-process MCP tools every dashboard session gets
// (`taskMcpServer` in lib/agent/manager.ts — typed, no key to pass, the server knows the session), and
// `POST /api/threads {"action":"report"}` for anything else. Haiku stays as the backup for chats that
// never report: `reportAt` newer than `evalAt` skips its reading for that quiet (see `ensure` in the route).
import { fid, mutateFlow, type FlowDod, type FlowState, type FlowThread } from "@/lib/flow-store";
import { threads, type ThreadView } from "@/lib/threads";

export const allDone = (dod?: FlowDod[]) => !!dod?.length && dod.every((d) => d.done);

// Done closes itself (Thomas, 2026-10-28: "I don't want to check the subtask done manually"). Only on
// the TRANSITION to all-met, never on a list that was already all met: a task he reopened, or one that
// came back because he replied in it (lib/threads.ts `revived`), stays open with Close until he says.
export function closeIfDone(t: FlowThread, wasDone: boolean) {
  if (wasDone || !allDone(t.dod)) return;
  t.archived = true; t.autoDone = true; t.doneAt = Date.now(); t.auto = false;
}

/** The open task that holds this chat, if any. */
export function taskOfSession(sessionId: string): ThreadView | undefined {
  return threads(14).threads.find((t) => t.sessions.some((x) => x.id === sessionId));
}

/** The stored record for a task, made on the spot for a derived one ("s:…" has nothing stored yet). */
export function storedFor(s: FlowState, v: ThreadView): FlowThread {
  let t = s.threads.find((x) => x.id === v.id);
  if (!t) {
    t = { id: v.id.startsWith("s:") ? fid() : v.id, title: v.title, project: v.project, cwd: v.cwd, sessions: v.sessions.map((x) => x.id), auto: true, createdAt: Date.now(), updatedAt: Date.now() };
    s.threads.unshift(t);
  }
  return t;
}

const itemLine = (d: FlowDod, i: number) =>
  `${i + 1}. [${d.done ? "x" : " "}] ${d.t}${d.done ? (d.by === "minami" ? " (ticked by Minami)" : " (ticked by Thomas)") : d.doing ? " (on now)" : ""}`;

/** What `task_status` hands the chat: the task and its numbered done-list. */
export function taskStatus(sessionId: string | null): string {
  const v = sessionId ? taskOfSession(sessionId) : undefined;
  if (!v) return "This chat is not part of an open task on Thomas's board. Nothing to report.";
  const dod = v.dod ?? [];
  return [
    `Task: "${v.title}" (project ${v.project})`,
    dod.length
      ? `Done-list${v.dodPending ? " (Minami's suggestion, not yet kept by Thomas)" : ""}:\n${dod.map(itemLine).join("\n")}`
      : "No done-list yet. You may add 2-4 checkable outcomes with task_report's `add`.",
  ].join("\n");
}

export type TaskReport = {
  /** 1-based item numbers now met, each with what shows it (a command's result, a file, a page). */
  done?: { n: number; why: string }[];
  /** The open item being worked on now, 1-based; 0 clears it. */
  now?: number;
  /** Items ticked earlier that are broken or reverted again. Thomas's own ticks are never touched. */
  undone?: number[];
  /** New items, when the list is missing something the task plainly needs. */
  add?: string[];
  /** Thomas said the whole task is done, or it is finished with nothing left: closes it. */
  finished?: string;
};

/** Apply a chat's own report to the task that holds it. Returns a line for the chat to read. */
export function taskReport(sessionId: string | null, r: TaskReport): string {
  const v = sessionId ? taskOfSession(sessionId) : undefined;
  if (!v) return "This chat is not part of an open task. Nothing recorded.";
  const said: string[] = [];
  mutateFlow((s) => {
    const t = storedFor(s, v);
    let dod = [...(t.dod ?? [])];
    const adds = (r.add ?? []).map((x) => String(x).trim().slice(0, 140)).filter(Boolean).slice(0, 4);
    if (adds.length) { dod = [...dod, ...adds.map((x) => ({ id: fid(), t: x, done: false }))]; said.push(`added ${adds.length}`); }
    const was = allDone(dod);
    const valid = (n: unknown): n is number => typeof n === "number" && n >= 1 && n <= dod.length;
    for (const d of r.done ?? []) {
      if (!valid(d?.n)) continue;
      const cur = dod[d.n - 1];
      if (cur.done && cur.by !== "minami") continue; // his tick stands
      // `by: "minami"` keeps the card's mark and lets him untick it; no `quote`, because the chat is
      // reporting its own work, not quoting evidence someone has to check against a transcript.
      dod[d.n - 1] = { id: cur.id, t: cur.t, done: true, by: "minami", why: String(d.why ?? "").slice(0, 120) || "reported by the chat", at: cur.done ? cur.at : Date.now() };
      said.push(`ticked ${d.n}`);
    }
    for (const n of r.undone ?? []) {
      if (!valid(n) || dod[n - 1].by !== "minami" || !dod[n - 1].done) continue;
      dod[n - 1] = { id: dod[n - 1].id, t: dod[n - 1].t, done: false };
      said.push(`unticked ${n}`);
    }
    // The chat's own word on which item is on beats Haiku's reading, and holds like a ▶ Do it (10 min).
    if (typeof r.now === "number") {
      dod = dod.map((d, i) => (i === r.now! - 1 && !d.done ? { ...d, doing: Date.now() } : d.doing ? (({ doing: _, ...rest }) => rest)(d) : d));
      if (r.now > 0 && valid(r.now)) said.push(`on ${r.now}`);
    }
    t.dod = dod;
    t.reportAt = Date.now();
    t.updatedAt = Date.now();
    if (!t.archived) closeIfDone(t, was);
    const fin = String(r.finished ?? "").trim().slice(0, 300);
    if (!t.archived && fin) {
      t.archived = true; t.autoDone = true; t.doneAt = Date.now(); t.auto = false; t.closedWhy = fin;
    }
    if (t.archived) said.push("task closed");
  });
  return said.length ? `Recorded: ${said.join(", ")}.` : "Nothing changed.";
}
