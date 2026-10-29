import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { handoffReport, STATUS_CONTRACT, type HandoffReport } from "@/lib/today-status";
import { closeTask, fid, mutateFlow, readFlow, type FlowDod, type FlowState } from "@/lib/flow-store";

// The Today page's store (§26). One JSON file per day in ~/.minami/today, written first by the vault's
// morning heartbeat (~/secondBrain/bin/morning-heartbeat.mjs, 07:30 via launchd) and then edited here
// as Thomas ticks to-dos, adds his own, answers open questions and logs notes. The heartbeat owns the
// SHAPE (it reads yesterday's file to plan today), so this module only mutates fields it defines.

/** `cwd` is where the chat actually runs — a worktree when the repo isolates, else the folder itself. */
/** `auto`: started by the Today runner (lib/today-autorun.ts), not by a tap. */
type HandoffMark = { how: "do" | "decide" | "ask"; sessionId: string; at: string; to?: string; cwd?: string; auto?: boolean };
export type TodayTodo = { id: string; title?: string; text: string; handoff?: HandoffMark; manual?: boolean;
  /** Who ticked it: "auto" = the model judge or a done_when check (vault today-sync), "minami" = its
   *  hand-off chat reported "TODAY: done" (lib/today-status.ts). Absent = Thomas. */
  done_by?: "auto" | "minami"; done_evidence?: string;
  /** Ids of to-dos that must be done first (written by the heartbeat). Its hand-off waits for them. */
  after?: string[];
  /** Machine checks that tick it (secondBrain/bin/today-checks.mjs); `progress` is their last partial result. */
  done_when?: Record<string, unknown>[];
  /** A to-do he typed is researched in the background (bin/today-research.mjs); `asked` keeps his own words. */
  research?: { state: "running" | "done" | "failed"; at: string; error?: string; usd?: number | null }; asked?: string;
  /** His comments on the task. `to: "chat"` = also sent into its hand-off chat; `instruction` = given with "Do it with Minami". */
  comments?: { at: string; text: string; to?: "chat" | "instruction" }[];
  /** Where it came from when another page made it (§26 "links"): a meeting's action item, an idea.
   *  Its own field, not markdown in `text`: the page renders text as plain words + `code`, and the
   *  research run rewrites `text` wholesale, which would drop a link written into it. */
  from?: { href: string; label: string };
  progress?: { met: number; total: number; detail: string }; why?: string; focus?: string; folder?: string; est_min?: number; cmd?: string; done: boolean; source: "heartbeat" | "you" | "carried"; done_at?: string };
export type TodayLoop = { id: string; header?: string; handoff?: HandoffMark; recommended?: number; question: string; context?: string; focus?: string; folder?: string; multiSelect?: boolean;
  options: { label: string; description?: string }[]; resolved: null | { answer: string | string[]; at: string };
  /** `resolved` is the decision; `done` is the work it was handed off to (a `decide` chat's "TODAY: done", reconcile). */
  done?: boolean; done_at?: string; done_by?: "minami"; done_evidence?: string };
/** Where the content pipeline's drafts stand, written by vault bin/today-sync.mjs every 10 min from
 *  bin/content-funnel.mjs: live (public sitemap) / prod_waiting / bench_only / in_progress. */
export type Pipeline = { seo?: { at: string; live_ok: boolean; counts: { live: number; prod_waiting: number; bench_only: number; in_progress: number }; waiting?: string[]; bench?: string[] } };
/** `autorun`: whether the runner starts this day's to-dos and decisions by itself (§26 "runs on its own").
 *  Absent = on — Thomas, 2026-10-29: "today task is going to be done autonomously without waiting for my input". */
export type TodayDay = { autorun?: boolean; pipeline?: Pipeline; date: string; status: "running" | "ready" | "facts-only" | "none"; built_at: string | null; started_at?: string; usd: number | null; error?: string | null; carried?: boolean;
  dropped?: string[]; // ids he dropped — the heartbeat won't re-suggest them on a Rebuild
  headline: string; focus: { id: string; name: string; status: string }[]; todos: TodayTodo[]; loops: TodayLoop[];
  research: { title: string; url: string; takeaway: string; focus?: string }[]; log: { at: string; kind: string; text: string }[] };

// MINAMI_TODAY_DIR is a test seam (the heartbeat honours it too): point a dev server at a scratch dir.
const DIR = process.env.MINAMI_TODAY_DIR || path.join(os.homedir(), ".minami/today");
const HEARTBEAT = path.join(os.homedir(), "secondBrain/bin/morning-heartbeat.mjs");
const RESEARCH = path.join(process.cwd(), "bin/today-research.mjs");
const NODE = fs.existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath;

export const localDate = (d = new Date()) => d.toLocaleDateString("en-CA");
const file = (date: string) => path.join(DIR, `${date}.json`);
const valid = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date);

export function readDay(date: string): TodayDay {
  if (!valid(date)) throw new Error("bad date");
  let raw: string;
  try { raw = fs.readFileSync(file(date), "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { date, status: "none", built_at: null, usd: null, headline: "", focus: [], todos: [], loops: [], research: [], log: [] };
    throw e;
  }
  // A file that exists but won't parse must not read as an empty day: the next tick would write that
  // empty day over it. Throwing turns into a 400 and nothing is written.
  try { return JSON.parse(raw); }
  catch { throw new Error(`day file ${date} is unreadable — fix or remove it`); }
}

export function listDays(): string[] {
  try { return fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse(); }
  catch { return []; }
}

function write(day: TodayDay) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${file(day.date)}.${process.pid}.${Date.now()}.tmp`; // unique: the heartbeat writes the same file
  fs.writeFileSync(tmp, JSON.stringify(day, null, 1));
  fs.renameSync(tmp, file(day.date)); // atomic: the heartbeat may be reading it
}

const now = () => new Date().toISOString();
const log = (day: TodayDay, kind: string, text: string) => day.log.push({ at: now(), kind, text });

export type TodayAction =
  | { op: "toggle"; id: string; done?: boolean } // `done` makes it idempotent: a stale tab can't flip it back
  // `from` / `folder`: set by the pages that hand a to-do over (meetings, ideas). `folder` pins where the
  // work runs: a to-do sent from an idea to Video Studio must not be re-homed by research.
  | { op: "add"; text: string; focus?: string; from?: { href: string; label: string }; folder?: string }
  | { op: "remove"; id: string }
  | { op: "resolve"; id: string; answer: string | string[] }
  | { op: "reopen"; id: string }
  | { op: "note"; text: string }
  | { op: "research"; id: string } // research a to-do again (after a failure, or a stalled run)
  | { op: "comment"; id: string; text: string }
  | { op: "autorun"; on: boolean };

/** Only same-origin paths: `from` is rendered as a link on the page, so a posted `javascript:` or an
 *  off-site URL must never reach it. */
function cleanFrom(f: unknown): TodayTodo["from"] {
  if (!f || typeof f !== "object") return undefined;
  const { href, label } = f as { href?: unknown; label?: unknown };
  if (typeof href !== "string" || !/^\/(?!\/)[^\s]*$/.test(href) || typeof label !== "string" || !label.trim()) return undefined;
  return { href: href.slice(0, 300), label: label.trim().slice(0, 80) };
}

// A tap aimed at an item that isn't in the file any more (a Rebuild on another device dropped it, or the
// page rolled over to a new day) must fail loudly: a silent 200 told Decide "That's settled" and lost it.
const gone = () => new Error("that item is no longer on this day's plan (it was rebuilt or the day changed) — reload");

export function applyAction(date: string, a: TodayAction): TodayDay {
  const day = readDay(date);
  // Only a real change writes: a no-op used to create the file and flip none→ready, which turned off
  // the heartbeat's carry-over for the day.
  let changed = false;
  let research: string | null = null;
  switch (a.op) {
    case "toggle": {
      const t = day.todos.find((x) => x.id === a.id); if (!t) throw gone();
      const want = typeof a.done === "boolean" ? a.done : !t.done;
      if (t.done === want) break;
      // `manual`: he decided this one himself, so the auto-tick (vault bin/today-sync.mjs) leaves it alone
      // from now on — it never re-ticks what he unticked, and never second-guesses what he ticked.
      t.done = want; t.done_at = t.done ? now() : undefined; t.manual = true; changed = true;
      if (!want) { delete t.done_by; delete t.done_evidence; }
      log(day, "todo", `${t.done ? "Done" : "Reopened"}: ${t.text}`);
      break;
    }
    case "add": {
      const text = a.text.trim(); if (!text) break;
      const id = crypto.createHash("sha1").update(text + now()).digest("hex").slice(0, 8);
      const from = cleanFrom(a.from);
      // A pinned folder skips research: research's whole output is a folder, a detail and a command,
      // and it would re-home the to-do (bin/today-research.mjs overwrites `folder`).
      const folder = typeof a.folder === "string" && /^~\/[\w./ -]+$/.test(a.folder) && !a.folder.includes("..") ? a.folder : undefined;
      day.todos.push({ id, text, asked: text, focus: a.focus || "other", done: false, source: "you", ...(from ? { from } : {}),
        ...(folder ? { folder } : { research: { state: "running" as const, at: now() } }) });
      log(day, "todo", `Added${from ? ` (from ${from.label})` : ""}: ${text}`); changed = true; research = folder ? null : id;
      break;
    }
    case "comment": {
      // A handed-off task's comment goes through commentTodo() (it also reaches the chat); this is the
      // plain note on a task nobody has started.
      const t = day.todos.find((x) => x.id === a.id); if (!t) throw gone();
      const text = a.text.trim(); if (!text) break;
      (t.comments ||= []).push({ at: now(), text });
      log(day, "comment", `${t.title || t.text.split("\n")[0]}: ${text}`); changed = true;
      break;
    }
    case "research": {
      const t = day.todos.find((x) => x.id === a.id); if (!t) throw gone();
      if (t.research?.state === "running" && Date.now() - Date.parse(t.research.at) < RESEARCH_STALL_MS) break;
      t.research = { state: "running", at: now() }; changed = true; research = t.id;
      break;
    }
    case "remove": {
      // A missing id stays a silent no-op: "already gone" is what he asked for, and a double tap mustn't error.
      const t = day.todos.find((x) => x.id === a.id); if (!t) break;
      (day.dropped ||= []).push(t.id);
      day.todos = day.todos.filter((x) => x.id !== a.id);
      log(day, "todo", `Dropped: ${t.text}`); changed = true;
      break;
    }
    case "resolve": {
      const l = day.loops.find((x) => x.id === a.id); if (!l) throw gone();
      // A running chat owns a handed-off answer; changing it here would never reach that chat.
      if (l.handoff) throw new Error("Minami already has this one — change it in the chat");
      l.resolved = { answer: a.answer, at: now() };
      log(day, "decision", `${l.question} → ${[].concat(a.answer as never).join(", ")}`); changed = true;
      break;
    }
    case "reopen": {
      const l = day.loops.find((x) => x.id === a.id); if (!l) throw gone();
      if (l.handoff) throw new Error("Minami already has this one — change it in the chat");
      l.resolved = null;
      log(day, "decision", `Reopened: ${l.question}`); changed = true;
      break;
    }
    case "note": {
      const text = a.text.trim(); if (text) { log(day, "note", text); changed = true; }
      break;
    }
    case "autorun": {
      if ((day.autorun !== false) === a.on) break;
      day.autorun = a.on; changed = true;
      log(day, "autorun", a.on ? "Runs on its own: on" : "Runs on its own: off — tasks wait for a tap");
      break;
    }
  }
  if (!changed) return day;
  if (day.status === "none") day.status = "ready";
  write(day);
  // After the write: the runner reads the to-do from the file.
  if (research) startResearch(date, research);
  return day;
}

// ── Research an added to-do (§26) ─────────────────────────────────────────────────────────────────
// He types a line; bin/today-research.mjs (one read-only sonnet call, 1–4 min) turns it into what the
// heartbeat would have written — title, detail, folder, command, done_when — so "Do it with Minami" has
// something to start from. Detached, like runHeartbeat: a deploy mustn't kill it halfway. A run that
// never wrote its end state (the Mac slept, the process died) reads as stalled after 10 min on the page.
export const RESEARCH_STALL_MS = 10 * 60e3;
function startResearch(date: string, id: string) {
  const out = fs.openSync(path.join(os.homedir(), ".minami/today-research.log"), "a");
  spawn(NODE, [RESEARCH, date, id], { cwd: path.dirname(path.dirname(RESEARCH)), detached: true, stdio: ["ignore", out, out] }).unref();
}

// ── Hand-offs (§26) ────────────────────────────────────────────────────────────────────────────────
// Three ways out of the page, all born server-side the same way §25's Explain is (a pane can't start
// with a message in it): `do` a to-do, let Minami `decide` a question on the recommended option and act
// on it, or `ask` a teammate through team-ask. Each returns a session id; the client opens /?open=<id>.
// The chat id is stored on the item, so a second tap reopens that chat instead of starting another.
// `starting` covers the 15 s before the mark is written: a double tap or a second device gets turned away.
const starting = new Set<string>();

/** `note`: his extra instruction for this run ("Do it with Minami" with a comment), placed above the task. */
/** `auto`: the runner started it — the chat is told nobody is watching, so it must not stop to ask. */
export type Handoff = { kind: "todo" | "loop"; id: string; how: "do" | "decide" | "ask"; member?: { key: string; name: string; role?: string }; answer?: string | string[]; note?: string; auto?: boolean };

// unknown, not string: day files written before the heartbeat coerced loop folders can hold anything.
const expand = (folder?: unknown) => (typeof folder === "string" && folder ? folder.replace(/^~(?=\/|$)/, os.homedir()) : os.homedir());

// A chat the runner started has nobody at the pane. An AskUserQuestion there holds the turn — and a runner
// slot — until he happens to open it, which is the waiting he asked to be rid of. So outward-facing work
// ends the turn on "TODAY: yours" instead: ready, and named on the page as the one thing left for him.
const OUTWARD_TAP = "Ask me before anything outward-facing (publishing, Slack, email, spending money).";
const OUTWARD_AUTO = "Nobody is watching this chat — my Today plan started it on its own. Work through every step without stopping to ask me. Anything outward-facing (publishing, Slack, email, spending money) or truly mine to decide: get it ready, don't do it, and end on \"TODAY: yours — …\" naming it, instead of asking a question and waiting.";

function handoffPrompt(day: TodayDay, h: Handoff): { message: string; cwd: string } {
  const outward = h.auto ? OUTWARD_AUTO : OUTWARD_TAP;
  const head = `From my Today page (${day.date}). Today's focus: ${day.focus.map((f) => `${f.name} — ${f.status}`).join(" · ")}`;
  if (h.kind === "todo") {
    const t = day.todos.find((x) => x.id === h.id)!;
    // His instruction comes first and is called that: it is the newest thing he said, and it outranks
    // the research write-up below it. Earlier comments follow the task as context.
    const note = h.note?.trim() ? `My instruction for this one: ${h.note.trim()}\n\n` : "";
    const said = (t.comments ?? []).filter((c) => c.to !== "instruction").map((c) => `- ${c.text}`).join("\n");
    return { cwd: expand(t.folder), message: `${head}\n\n${note}Do this to-do for me, end to end, then tell me in a few lines what you did and what's left:\n\n**${t.title || t.text}**\n${t.title ? t.text + "\n" : ""}${t.why ? `Why: ${t.why}\n` : ""}${t.asked && t.asked !== t.text ? `(I typed: "${t.asked}" — the detail above is Minami's research on it; my words win if they disagree.)\n` : ""}${t.cmd ? `Suggested command: \`${t.cmd}\`\n` : ""}${said ? `My comments on it:\n${said}\n` : ""}\n${outward}\n\n${STATUS_CONTRACT}` };
  }
  const l = day.loops.find((x) => x.id === h.id)!;
  const opts = l.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n");
  if (h.how === "ask") {
    const m = h.member!;
    return { cwd: expand(l.folder), message: `${head}\n\nI don't know the answer to this one, so ask ${m.name}${m.role ? ` (${m.role})` : ""} for me with the ask_team tool: assignee "${m.key}", mode "fire" (don't wait). I've already confirmed sending it by tapping "Ask ${m.name}" — don't ask me again. Keep my question and options verbatim, add a short doing/why_now from the context, and a recommendation based on the first option.\n\nQuestion: ${l.question}\nContext: ${l.context || "—"}\nOptions:\n${opts}\n\nAfter it's sent, reply with one line: the ticket and that it's out.` };
  }
  const answer = h.answer ? [].concat(h.answer as never).join(", ") : null;
  return { cwd: expand(l.folder), message: `${head}\n\n${answer ? `I decided: **${answer}**.` : "Decide this for me — take the recommended option unless the facts on disk clearly say otherwise, and tell me which you took and why in one line."}\n\nQuestion: ${l.question}\nContext: ${l.context || "—"}\nOptions:\n${opts}\n\nNow carry it out. ${outward}\n\n${STATUS_CONTRACT}` };
}

/** Prerequisites (`after`) that aren't done yet. An id that's no longer in the day (dropped, or a
 *  rebuild renamed it) doesn't hold anything up. */
export function unmetDeps(day: TodayDay, t: TodayTodo): TodayTodo[] {
  return (t.after ?? []).map((id) => day.todos.find((x) => x.id === id)).filter((x): x is TodayTodo => !!x && !x.done);
}

/** `need`: the chat is waiting on him (a question, a plan, a held tool call), from liveActivity() — the
 *  same pending entry the pane and the board show. Sent with the day so the row says "waiting on you"
 *  on first paint and on a device whose /api/agent/live poll hasn't landed yet. */
export type ItemStatus = HandoffReport & { busy: boolean; live: boolean; need?: { kind: string; summary: string } };

/** What each hand-off came to, and the ticks that follow from it (§26).
 *
 *  Ticks a to-do — or a decision handed to Minami to carry out (`decide`) — whose chat's last status
 *  line is "TODAY: done", unless Thomas set the box himself (`manual`): a tick he took back stays taken
 *  back, the same rule the vault auto-tick keeps. An `ask` is finished when the card is out; it has no
 *  work to tick. Writes the day only when something changed. Returns a report per item id for the page. */
export async function reconcile(date: string): Promise<{ day: TodayDay; status: Record<string, ItemStatus> }> {
  const { liveStats, liveActivity } = await import("@/lib/agent/manager");
  const live = new Map(liveStats().details.filter((d) => d.sessionId).map((d) => [d.sessionId as string, d]));
  const tiles = liveActivity();
  const day = readDay(date);
  const status: Record<string, ItemStatus> = {};
  let changed = false;
  for (const it of [...day.todos, ...day.loops] as (TodayTodo & TodayLoop)[]) {
    const h = it.handoff;
    if (!h?.sessionId) continue;
    const l = live.get(h.sessionId);
    const r = handoffReport(h.sessionId, [it.folder, h.cwd], !!l?.busy);
    const need = tiles[h.sessionId]?.need;
    status[it.id] = { ...r, busy: !!l?.busy, live: !!l, ...(need ? { need: { kind: need.kind, summary: need.summary } } : {}) };
    if (h.how !== "ask" && r.outcome?.state === "done" && !r.outcome.stale && !it.done && !it.manual) {
      it.done = true; it.done_at = new Date(r.outcome.at).toISOString(); it.done_by = "minami";
      it.done_evidence = `Minami's chat reported it done${r.outcome.why ? ` — ${r.outcome.why}` : ""}.`;
      log(day, "auto", `Done (Minami reported): ${it.title || it.text || it.question}`);
      changed = true;
    }
  }
  if (linkTasks(day)) changed = true;
  if (changed) write(day);
  return { day, status };
}

// ── Today work is task work (§37, Thomas 2026-10-29: "merge them") ───────────────────────────────────
// A log sweep found 2 of 78 handed-off to-dos on the task board: a hand-off he never typed in is a
// machine session to lib/threads.ts, so everything the Today runner did was invisible there, under a
// second done-list system (`done_when`). Now every hand-off that does work (`do`, `decide`; an `ask` is
// only a Slack card) is stored as a task holding its chat. A stored claim bypasses the machine filter.
// Each side closes the other: the to-do ticked (its chat's "TODAY: done", the vault's done_when check,
// his tap) closes the task; the task closed (all items met, "finished", ✓ Done) ticks the to-do — unless
// he set the to-do's box by hand (`manual`), the same rule reconcile keeps.

/** A machine check as an outcome he can read. Unknown kinds fall back to their fields. */
function checkLabel(w: Record<string, unknown>): string {
  const s = (k: string) => (typeof w[k] === "string" ? (w[k] as string) : "");
  if (w.kind === "live") return `${s("what") || "page"} live at ${s("path")}`;
  if (w.kind === "commit") return `committed in ${path.basename(s("folder")) || "the repo"}${s("grep") ? ` (“${s("grep")}”)` : ""}`;
  if (w.kind === "file") return `${path.basename(s("path"))} written`;
  if (w.kind === "gate") return `draft ${s("draft")} is ${s("status")}`;
  return Object.entries(w).map(([k, v]) => `${k}: ${String(v)}`).join(", ");
}

/** Store a task for each working hand-off of the day and keep both sides' done state in step. Changes the
 *  day in place; true when it did. Writes flow.json only when something there changed. */
export function linkTasks(day: TodayDay): boolean {
  const flow = readFlow();
  const items = [...day.todos.map((x) => ["todo", x] as const), ...day.loops.map((x) => ["loop", x] as const)]
    .filter(([, x]) => x.handoff?.sessionId && x.handoff.how !== "ask");
  let dayChanged = false;
  const edits: ((s: FlowState) => void)[] = [];
  for (const [kind, it] of items) {
    const sid = it.handoff!.sessionId;
    const st = flow.threads.find((t) => t.today?.date === day.date && t.today.id === it.id) ?? flow.threads.find((t) => t.sessions.includes(sid));
    const done = !!it.done;
    if (!st) {
      // Only work still open: the hand-offs already done before this shipped would bury his own tasks in
      // the Done column. A later tick closes the task through the branch below.
      if (done || Date.now() - (Date.parse(it.handoff!.at) || 0) > 3 * 86_400_000) continue;
      const cwd = it.handoff!.cwd || expand(it.folder);
      const base = cwd.includes("/.minami-worktrees/") ? cwd.slice(0, cwd.indexOf("/.minami-worktrees/")) : cwd;
      const checks = kind === "todo" ? ((it as TodayTodo).done_when ?? []) : [];
      const at = Date.parse(it.handoff!.at) || Date.now();
      const id = fid();
      edits.push((s) => {
        if (s.threads.some((t) => t.sessions.includes(sid))) return; // another process linked it meanwhile
        s.threads.unshift({ id, title: handoffLabel(it), project: path.basename(base), cwd: base, sessions: [sid], origin: "today",
          today: { date: day.date, kind, id: it.id }, auto: true, createdAt: at, updatedAt: Date.now(),
          ...(checks.length ? { dod: checks.slice(0, 4).map((w, i): FlowDod => ({ id: `${id}-${i}`, t: checkLabel(w), done: false, gate: null })) } : {}) });
      });
      continue;
    }
    if (!st.today) edits.push((s) => { const t = s.threads.find((x) => x.id === st.id); if (t && !t.today) t.today = { date: day.date, kind, id: it.id }; });
    // A task he reopened stays open: only a tick newer than the Reopen closes it again.
    if (done && !st.archived && (Date.parse(it.done_at ?? "") || Date.now()) > (st.reopenedAt ?? 0)) {
      const why = it.done_evidence || (it.done_by ? "ticked on the Today page" : "Thomas ticked it on Today");
      edits.push((s) => { const t = s.threads.find((x) => x.id === st.id); if (t && !t.archived) closeTask(t, { auto: true, why: why.slice(0, 300) }); });
    } else if (!done && st.archived && !("manual" in it && it.manual)) {
      it.done = true; it.done_at = new Date(st.doneAt ?? Date.now()).toISOString(); it.done_by = "minami";
      it.done_evidence = `Its task closed${st.closedWhy ? ` — ${st.closedWhy}` : " with every done-item met"}.`;
      log(day, "auto", `Done (task closed): ${handoffLabel(it)}`);
      dayChanged = true;
    }
  }
  if (edits.length) mutateFlow((s) => { for (const e of edits) e(s); }, "today");
  return dayChanged;
}

/** A hand-off's human name: the to-do's title, or the question. One line, short enough for a tab. */
function handoffLabel(item: TodayTodo | TodayLoop): string {
  const t = ("title" in item && item.title) || ("text" in item && item.text) || ("question" in item && item.question) || "Today task";
  const one = String(t).split("\n")[0].trim();
  return one.length > 70 ? `${one.slice(0, 69)}…` : one;
}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "task";

/** Titles of today's hand-offs whose chat is live right now in `folder` (not ended). */
function liveHandoffsIn(day: TodayDay, folder: string, live: { sessionId: string | null; cwd: string }[]): string[] {
  const alive = new Set(live.filter((d) => d.sessionId && path.resolve(d.cwd) === path.resolve(folder)).map((d) => d.sessionId));
  return [...day.todos, ...day.loops].filter((x) => x.handoff && alive.has(x.handoff.sessionId)).map((x) => handoffLabel(x));
}

export async function handoff(date: string, h: Handoff): Promise<{ ok: boolean; sessionId?: string; error?: string; day?: TodayDay }> {
  const { sendMessage, liveStats } = await import("@/lib/agent/manager");
  const day = readDay(date);
  const item = h.kind === "todo" ? day.todos.find((x) => x.id === h.id) : day.loops.find((x) => x.id === h.id);
  if (!item) return { ok: false, error: "not found" };
  if (item.handoff) return { ok: true, sessionId: item.handoff.sessionId, day };
  // A dependent task started early runs straight into the wall its prerequisite exists to remove:
  // three publish hand-offs on 2026-10-12 hit "no prod CMS target" while the task that settles it ran
  // beside them. The page disables the button; this is the server saying the same.
  const waitingOn = h.kind === "todo" ? unmetDeps(day, item as TodayTodo) : [];
  if (waitingOn.length) return { ok: false, error: `starts after: ${waitingOn.map((t) => t.title || t.text).join(", ")}` };
  const lockKey = `${date}:${h.kind}:${h.id}`;
  if (starting.has(lockKey)) return { ok: false, error: "already starting — give it a few seconds" };
  starting.add(lockKey);
  try {
    const { message, cwd } = handoffPrompt(day, h);
    if (!fs.existsSync(cwd)) return { ok: false, error: `folder ${cwd} doesn't exist` };
    const key = `today-${h.how}-${h.id}-${Date.now().toString(36)}`;
    const label = handoffLabel(item);

    // ⚠️ A HAND-OFF MUST BE PLACED LIKE ANY CHAT. A pane gets its worktree from the browser
    // (/api/worktree) before its first send; a hand-off is started here, server-side, and skipped that
    // entirely — so nine Today hand-offs put six chats on one branch of ~/ecvisionContent and the pane
    // said "6 agents are live in this folder — they share one branch and will overwrite each other"
    // (2026-10-12). isolate() honours the repo's own minami.isolate: eager → a worktree each, lazy →
    // shared until a chat writes under contention, off → the folder itself (a workspace that is mostly
    // uncommitted, like ecvisionContent, where a checkout of HEAD would be nearly empty).
    const { isolate } = await import("@/lib/worktree");
    const iso = await isolate(cwd, `today-${slug(label)}`, "birth").catch(() => null);
    const runCwd = iso?.dir ?? cwd;

    // Sharing a folder is then a fact the chat should KNOW, not discover: name the other hand-offs
    // working there so each keeps to its own files.
    const others = iso ? [] : liveHandoffsIn(day, cwd, liveStats().details).filter((t) => t !== label);
    const shared = others.length
      ? `\n\nOther Minami chats from my Today page are working in this same folder right now:\n${others.map((t) => `- ${t}`).join("\n")}\nKeep to your own task's files. If you must change a shared file (a backlog, a log, a playbook), re-read it immediately before editing and add to it rather than rewrite it.`
      : "";

    // The first line IS the chat's name everywhere (§5h: the title seed is the opening line). It used
    // to be "From my Today page (date)…" — identical for every hand-off, so the board showed six chats
    // with one name and the one asking a question could not be found.
    const titled = `Today · ${label}\n\n${message}${shared}`;
    // No `mode`: a hand-off runs like any chat he opens himself (the install default, DEFAULT_PERMISSION_MODE).
    // Pinning "acceptEdits" here made every Today task stop for approval on each shell command.
    let { sessionId } = sendMessage({ key, cwd: runCwd, message: titled });
    for (let i = 0; !sessionId && i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      sessionId = liveStats().details.find((d) => d.key === key)?.sessionId ?? null;
    }
    if (!sessionId) return { ok: false, error: "the chat didn't start in time — look for it on the board" };
    const fresh = readDay(date); // re-read: the chat took seconds to start and the page may have written since
    const it = (h.kind === "todo" ? fresh.todos : fresh.loops).find((x) => x.id === h.id) as (TodayTodo | TodayLoop) | undefined;
    if (it?.handoff) return { ok: true, sessionId: it.handoff.sessionId, day: fresh }; // another process got there first
    if (it) {
      it.handoff = { how: h.how, sessionId, at: now(), to: h.member?.name, cwd: runCwd, ...(h.auto ? { auto: true } : {}) };
      if (h.kind === "todo" && h.note?.trim()) ((it as TodayTodo).comments ||= []).push({ at: now(), text: h.note.trim(), to: "instruction" });
      // Always overwrite: the stored answer must be the one the chat was given. An earlier pick he
      // backed out of (Decide → Back → "Let Minami decide") is not what Minami was told.
      if (h.kind === "loop" && h.how !== "ask")
        (it as TodayLoop).resolved = { answer: h.answer ?? "Minami decides", at: now() };
    }
    // The chat started either way, so it's logged either way: if a Rebuild dropped the item meanwhile,
    // label it from the copy read before the start rather than logging "undefined".
    const src = (it ?? item) as TodayTodo & TodayLoop;
    log(fresh, "handoff", h.how === "ask" ? `Asked ${h.member?.name}: ${src.question}` : `${h.auto ? "Started on its own" : "Handed to Minami"}: ${src.title || src.text || src.question}`);
    write(fresh);
    return { ok: true, sessionId, day: fresh };
  } finally { starting.delete(lockKey); }
}

/** A comment on a to-do Minami is already working on: saved on the task AND sent into its chat, so
 *  he can steer it from the Today page without finding the pane. A live chat gets it as its next turn
 *  (queued if it's mid-turn, the way a pane's composer does); one that closed or didn't survive a
 *  restart is resumed from its transcript under a fresh key. A task nobody started gets a plain
 *  comment (applyAction "comment"), which the hand-off message carries later. */
export async function commentTodo(date: string, id: string, text: string): Promise<{ ok: boolean; error?: string; day?: TodayDay }> {
  const body = text.trim();
  if (!body) return { ok: false, error: "empty comment" };
  const day = readDay(date);
  const t = day.todos.find((x) => x.id === id);
  if (!t) return { ok: false, error: "that item is no longer on this day's plan — reload" };
  if (!t.handoff?.sessionId) return { ok: true, day: applyAction(date, { op: "comment", id, text: body }) };
  const { sendMessage, liveStats } = await import("@/lib/agent/manager");
  const h = t.handoff;
  const owner = liveStats().details.find((d) => d.sessionId === h.sessionId);
  const cwd = owner?.cwd ?? h.cwd ?? expand(t.folder);
  if (!fs.existsSync(cwd)) return { ok: false, error: `the chat's folder ${cwd} is gone — open the chat instead` };
  try {
    sendMessage(owner
      ? { key: owner.key, cwd, message: `(From my Today page) ${body}` }
      : { key: `today-comment-${id}-${Date.now().toString(36)}`, cwd, message: `(From my Today page) ${body}\n\n${STATUS_CONTRACT}`, resume: h.sessionId });
  } catch (e) { return { ok: false, error: String((e as Error).message || e) }; }
  const fresh = readDay(date);
  const it = fresh.todos.find((x) => x.id === id);
  if (it) {
    (it.comments ||= []).push({ at: now(), text: body, to: "chat" });
    log(fresh, "comment", `To Minami (${it.title || it.text.split("\n")[0]}): ${body}`);
    write(fresh);
  }
  return { ok: true, day: fresh };
}

// "Run it now" — the same script launchd runs at 07:30, detached so a dashboard restart can't kill it.
export function runHeartbeat(): { started: boolean; reason?: string } {
  const day = readDay(localDate());
  const started = day.started_at ? Date.parse(day.started_at) : 0;
  if (day.status === "running" && Date.now() - started < 20 * 60e3) return { started: false, reason: "already running" };
  const out = fs.openSync(path.join(os.homedir(), ".minami/heartbeat.log"), "a");
  spawn(NODE, [HEARTBEAT], { cwd: path.dirname(path.dirname(HEARTBEAT)), detached: true, stdio: ["ignore", out, out] }).unref();
  return { started: true };
}
