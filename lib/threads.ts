// Threads (§37): "where you left off", derived from the transcripts rather than declared.
//
// Measured over 14 days (the 2026-10-28 debate): 71% of sessions are machine-made (classifiers,
// summarizers, runners) and another 18% are one-tap Today/Autopilot hand-offs, most with a single
// message. The morning problem was never a missing task object — it was finding Thomas's OWN
// conversations under all of that. So a thread here is:
//   · one session he typed in (machine sessions and untouched hand-offs never count), or
//   · that session plus the continuation that picked it up after its context ran out, or
//   · whatever he joined by hand / named (lib/flow-store.ts keeps only those).
// Nothing has to be created for this list to be right on the first morning.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBusy } from "@/lib/agent/manager";
import { listSessions, topicOf, type SessionMeta } from "@/lib/claude-sessions";
import { readFlow, type FlowDod } from "@/lib/flow-store";
import { todaySessionIds } from "@/lib/today-origin";

const WT = "/.minami-worktrees/";
export const baseCwd = (cwd: string) => (cwd.includes(WT) ? cwd.slice(0, cwd.indexOf(WT)) : cwd);

// Opening lines of sessions the dashboard or a tool writes, never Thomas. Matched on the title (the
// first real line) — the transcript has no origin field (SessionMeta carries none).
const MACHINE = /^(each line is a claude code chat|you classify|you are minami|you are a |reply with|<local-command|model_ok|write a one-line|summari[sz]e |classify |rate |score |return only|output only|merge conflict|resolve the merge)/i;
const HANDOFF = /^(today|autopilot|goal|runners?) ·/i;

export function isMachine(m: SessionMeta, today: Set<string>): boolean {
  if (m.cwd.includes(".minami-bento") || m.cwd.includes("/.minami/automations/.")) return true;
  const t = (m.title || m.lastPrompt || "").trim();
  if (!t || MACHINE.test(t)) return true;
  // A hand-off he never replied to is the machine's work, not his thread. One he answered is his.
  if ((today.has(m.id) || HANDOFF.test(t)) && (m.askCount ?? 0) < 2) return true;
  return false;
}

// ── first line + start time, read once per session ─────────────────────────────────────────────
// SessionMeta has neither when a session began nor its literal first message (the parser skips the
// compaction summary a continuation opens with). Both are fixed for the life of the file, so they are
// read once from its head and cached by id.
const head = new Map<string, { start: number; first: string } | null>();
function headOf(m: SessionMeta): { start: number; first: string } | null {
  if (head.has(m.id)) return head.get(m.id)!;
  let out: { start: number; first: string } | null = null;
  try {
    const file = path.join(os.homedir(), ".claude", "projects", m.cwd.replace(/[^a-zA-Z0-9]/g, "-"), m.id + ".jsonl");
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(96 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    let start = 0;
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let r: { type?: string; timestamp?: string; message?: { content?: unknown } };
      try { r = JSON.parse(line); } catch { continue; }
      if (!start && r.timestamp) start = Date.parse(r.timestamp) || 0;
      if (r.type !== "user") continue;
      const c = r.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? (c.find((b: { type?: string }) => b?.type === "text") as { text?: string } | undefined)?.text ?? "" : "";
      if (text) { out = { start, first: text.slice(0, 400) }; break; }
    }
  } catch { /* no file at the expected path: the session simply isn't linked */ }
  head.set(m.id, out);
  return out;
}
/** The tail of a chat as plain "Thomas:" / "Minami:" lines — what Minami reads to tick a done-list.
 *  Only the last 400KB: the end of the conversation is where "done" gets said. */
export function recentText(id: string, cwd: string, max = 6000): string {
  try {
    const file = path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), id + ".jsonl");
    const size = fs.statSync(file).size;
    const len = Math.min(size, 400 * 1024);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const out: string[] = [];
    for (const line of buf.toString("utf8").split("\n")) {
      let r: { type?: string; message?: { content?: unknown } };
      try { r = JSON.parse(line); } catch { continue; }
      if (r.type !== "user" && r.type !== "assistant") continue;
      const c = r.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("\n") : "";
      if (!text.trim() || text.startsWith("<")) continue;
      out.push(`${r.type === "user" ? "Thomas" : "Minami"}: ${text.trim().slice(0, 1500)}`);
    }
    let s = out.join("\n\n");
    if (s.length > max) s = "…" + s.slice(-max);
    return s;
  } catch { return ""; }
}

const CONTINUED = /^This session is being continued from a previous conversation/;

export type ThreadState = "working" | "waiting" | "idle" | "queued";
export type ThreadView = {
  id: string; stored: boolean; title: string; project: string; cwd: string;
  sessions: { id: string; cwd: string }[];
  latest: string; at: number; state: ThreadState; line: string; asks: number;
  dod?: FlowDod[]; dodPending?: boolean;
  /** Archived (moved to Done). Only in `done`, never in `threads`. */
  archived?: boolean; doneAt?: number; autoDone?: boolean; closedWhy?: string;
};
export type ProjectRef = { project: string; cwd: string; at: number };

const titleOf = (m: SessionMeta) => m.now || m.task || m.title || "Untitled chat";
// The tail is the raw end of a message: code fences, markdown and harness tags read as noise in a
// one-line "where it stands".
const plain = (t: string) => t.startsWith("<task-notification>") ? "" : t
  .replace(/```[\s\S]*?(```|$)/g, " ").replace(/<[^>]+>/g, " ").replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function threads(days = 7): { threads: ThreadView[]; done: ThreadView[]; projects: ProjectRef[]; dismissed: string[]; human: Set<string> } {
  const store = readFlow();
  const today = todaySessionIds();
  const all = listSessions();
  const since = Date.now() - days * 86_400_000;
  const human = all.filter((m) => !isMachine(m, today));
  const byId = new Map(all.map((m) => [m.id, m]));

  // Continuations join the conversation they continue: the latest of his sessions in the same project
  // that was last active before this one began.
  const parent = new Map<string, string>();
  for (const m of human) {
    const h = headOf(m);
    if (!h || !CONTINUED.test(h.first)) continue;
    const prev = human.filter((x) => x.id !== m.id && x.project === m.project && x.lastActivity <= h.start + 60_000)
      .sort((a, b) => b.lastActivity - a.lastActivity)[0];
    if (prev) parent.set(m.id, prev.id);
  }
  const root = (id: string) => { let r = id; for (let i = 0; i < 20 && parent.has(r); i++) r = parent.get(r)!; return r; };

  const claimed = new Map<string, string>();
  // An archived thread still claims its sessions — otherwise archiving one hands its chats straight
  // back as a derived thread and it reappears on the next poll.
  // (They are still built below, into `done`, for the board's Done column.)
  for (const t of store.threads) for (const sid of t.sessions) claimed.set(sid, t.id);

  const groups = new Map<string, { stored?: (typeof store.threads)[number]; ids: Set<string> }>();
  for (const t of store.threads) groups.set(t.id, { stored: t, ids: new Set(t.sessions) });
  for (const m of human) {
    const key = claimed.get(m.id) ?? claimed.get(root(m.id)) ?? "s:" + root(m.id);
    const g = groups.get(key) ?? { ids: new Set<string>() };
    g.ids.add(m.id); groups.set(key, g);
  }

  const views: ThreadView[] = [];
  const done: ThreadView[] = [];
  for (const [id, g] of groups) {
    const ms = [...g.ids].map((x) => byId.get(x)).filter(Boolean) as SessionMeta[];
    const st = g.stored;
    if (st?.hidden) continue;
    // A To-do card: written down on the board, no chat yet.
    if (!ms.length && st?.queued && !st.archived) {
      views.push({ id, stored: true, title: st.title, project: st.project, cwd: st.cwd, sessions: [], latest: "", at: st.createdAt,
        state: "queued", line: "", asks: 0, ...(st.dod ? { dod: st.dod, dodPending: st.dodPending } : {}) });
      continue;
    }
    if (!ms.length) continue;
    ms.sort((a, b) => a.lastActivity - b.lastActivity);
    const last = ms[ms.length - 1];
    // A task that closed itself on its last tick and then got a new message from Thomas is open again:
    // the work wasn't over. Two things deliberately do NOT revive it (🐛 2026-10-28, §37):
    //  - any write to the transcript. This used `lastActivity`, which is the file's mtime too, so the
    //    chat's own sign-off, a metadata row or a deploy bumped it and every self-closed task came back
    //    after a deploy. Only a typed message counts (`lastUserAt`).
    //  - a task closed by words ("this one is done", task_report finished, the close API — `closedWhy`).
    //    He said the whole thing is done; open items don't overrule that, and Reopen is one tap.
    const typed = Math.max(0, ...ms.map((m) => m.lastUserAt ?? 0));
    const revived = !!st?.archived && !!st.autoDone && !st.closedWhy && typed > (st.doneAt ?? 0) + 120_000;
    if (st?.archived && !revived) {
      // Done keeps two weeks, so a finished task is still there to reopen the next week.
      if ((st.doneAt ?? st.updatedAt) > Date.now() - 14 * 86_400_000) done.push({
        id, stored: true, title: clip(st.title, 90), project: st.project || ms[ms.length - 1].project, cwd: st.cwd,
        sessions: ms.map((m) => ({ id: m.id, cwd: m.cwd })), latest: ms[ms.length - 1].id, at: ms[ms.length - 1].lastActivity,
        state: "idle", line: "", asks: 0, archived: true, doneAt: st.doneAt ?? st.updatedAt, autoDone: !!st.autoDone, closedWhy: st.closedWhy, ...(st.dod ? { dod: st.dod } : {}),
      });
      continue;
    }
    if (last.lastActivity < since && (!g.stored || g.stored.auto)) continue;
    const busy = ms.some((m) => isBusy("live:" + m.id));
    const waiting = !busy && (!!last.review || last.lastRole === "assistant" && /\?\s*$/.test(last.tail || ""));
    const state: ThreadState = busy ? "working" : waiting ? "waiting" : "idle";
    const tail = plain(last.tail || "");
    views.push({
      id, stored: !!g.stored, title: clip(g.stored?.title || titleOf(last), 90), project: last.project, cwd: baseCwd(last.cwd),
      sessions: ms.map((m) => ({ id: m.id, cwd: m.cwd })), latest: last.id, at: last.lastActivity, state,
      line: clip(state === "working" ? (last.now || tail || "working") : tail || last.lastPrompt || "", 140),
      asks: ms.reduce((n, m) => n + (m.askCount ?? 0), 0),
      ...(g.stored?.dod ? { dod: g.stored.dod, dodPending: !!g.stored.dodPending } : {}),
    });
  }
  views.sort((a, b) => b.at - a.at);

  const proj = new Map<string, ProjectRef>();
  for (const m of all) {
    if (!m.project || m.cwd.includes(".minami-bento")) continue;
    const p = proj.get(m.project);
    const cwd = baseCwd(m.cwd);
    if (!p) proj.set(m.project, { project: m.project, cwd, at: m.lastActivity });
    else if (m.lastActivity > p.at) proj.set(m.project, { ...p, at: m.lastActivity, cwd: p.cwd.includes(WT) ? cwd : p.cwd });
  }
  return {
    done: done.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 40),
    threads: views.slice(0, 60), // Home shows 4–10; an expanded tile needs its own topic's tasks, not just the newest overall
    projects: [...proj.values()].sort((a, b) => b.at - a.at).slice(0, 20).map((p) => ({ ...p, project: topicOf(p.cwd).project || p.project })),
    dismissed: store.dismissed,
    human: new Set(human.map((m) => m.id)),
  };
}
