// Threads (§37): a piece of work that outlives one session. Most threads are never stored — the read
// pipeline derives them (one human session, or a session plus the continuation that picked it up after
// context ran out). This file only keeps what can't be derived: a name you gave a thread, the sessions
// joined to it by hand or by a split, and its Definition of Done.
//
// Read from disk on every call, never cached in memory: the preview server (:3001) and the live one
// (:3000) can both load this module, and a per-process cache would let one silently overwrite the
// other's edits. The file is small, so the read costs nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = process.env.MINAMI_FLOW_FILE || path.join(os.homedir(), ".minami", "flow.json");

/** `by: "minami"` — ticked by Minami reading the chat (`why` says what it saw); a tap by Thomas clears it. */
export type FlowDod = { id: string; t: string; done: boolean; at?: number; by?: "minami"; why?: string;
  /** Words copied from the chat that show the item is met; kept only if they really are in the chat. */
  quote?: string; quoteBy?: "Thomas" | "Minami";
  /** When this item became the one being worked on — by ▶ Do it, or Minami reading the chat. At most
   *  one open item carries it; the card turns it into "Minami working" / "needs you" / "started". */
  doing?: number;
  /** Where a run stops for Thomas (lib/task-pace.ts): "pitch" = versions to pick from, "ok" = ask before
   *  it leaves the machine, null = the chat just does it. Absent = not classified yet (runs like null). */
  gate?: "pitch" | "ok" | null; gateWhy?: string;
  /** He set the gate by tapping it: Haiku never reclassifies it. */
  gateBy?: "thomas";
  /** What made a `by: "minami"` tick: the task's own chat (task_report), git / the live build, or the
   *  Today to-do it carries. Minami's reading of a chat never ticks (2026-10-29): see `seen`. */
  src?: "chat" | "git" | "today";
  /** Minami's reading thinks this open item is met, with what it saw. A suggestion only: it doesn't count
   *  as progress and never closes the task. His tap turns it into a tick. Thomas, 2026-10-29: done is the
   *  chat's own report plus artifacts — 36% of closed tasks had closed with items still open. */
  seen?: { why: string; quote?: string; quoteBy?: "Thomas" | "Minami"; at: number } };
/** The one thing a quiet task waits on him for (§37). `q` is short and plain ("Merge and deploy it?"),
 *  `yes` the button label, `reply` what that button sends to the chat in his voice. `ship`: it is about
 *  merging / deploying / publishing, so a list without a ship item gets one. */
export type TaskStep = { q: string; yes: string; reply: string; ship?: boolean; at: number };
export type FlowThread = {
  id: string; title: string; project: string; cwd: string;
  /** Session ids, oldest first. A session belongs to at most one stored thread. */
  sessions: string[];
  dod?: FlowDod[];
  /** Retired 2026-10-29: "Minami's suggestion, tap Keep". 52 of 58 lists were never kept, and the
   *  suggestion drove ticks and closes anyway, so the tap decided nothing. Minami's list is now just the
   *  list. Still written as false by old paths and ignored on read. */
  dodPending?: boolean;
  /** Retired shape of the proposal (a bare list); folded into `dod` + `dodPending` on read. */
  dodSuggested?: string[];
  /** Stored only to hold Minami's done-list on a derived thread: ages out after a week like one. */
  auto?: boolean;
  /** A To-do card: written down, no chat started yet. `sessions` is empty until Start. */
  queued?: boolean;
  /** Last activity Minami checked the DoD against; a newer reply means check again. */
  evalAt?: number;
  /** Last time Minami read a RUNNING chat to see which item it is on (throttled, see ensure). */
  focusAt?: number;
  /** When a done-list was asked for and none came back, so it isn't asked for on every poll. */
  dodTriedAt?: number;
  /** Last time the task's own chat reported progress itself (`task_report`, lib/task-report.ts). A report
   *  newer than `evalAt` stands in for Minami's reading, so the Haiku check is skipped for that quiet. */
  reportAt?: number;
  /** Last time Haiku was asked to gate items that had none, so a failed call isn't repeated every poll. */
  gateTriedAt?: number;
  /** Auto-continue (ensure in /api/threads): when the server last nudged the chat on to the next item,
   *  how many nudges since Thomas last typed, and how many items were met at that nudge. */
  nudgeAt?: number; nudges?: number; nudgeMet?: number;
  createdAt: number; updatedAt: number; archived?: boolean; doneAt?: number;
  /** Archived by itself: the last done-item got ticked (by Minami or him). The page celebrates these
   *  once, and a reply in the chat afterwards brings the task back. */
  autoDone?: boolean;
  /** Why it closed when not every item was ticked: the words in the chat that said the whole task is
   *  done, or "closed from the chat" (the `close` API). Also how a revived task avoids re-closing on the
   *  same old words. */
  closedWhy?: string;
  /** Closed with Abort: no longer needed, not finished. It sits in Done (Reopen still works) but never
   *  counts as done anywhere: no "✓ Done", no Today tick, and a later message in its chat doesn't revive
   *  it. Thomas, 2026-10-30: "for task no longer needed — but not a done task". */
  aborted?: boolean;
  /** Every item is met but the chat was mid-turn or asking him when that happened, so the close waits
   *  for a reading of a quiet chat (evaluate in /api/threads). See closeIfDone in lib/task-report.ts. */
  closeHeld?: boolean;
  /** What the task waits on from him now, read off the end of its chat when the chat goes quiet
   *  (readStep in /api/threads): the question it ended on, or the obvious unshipped step ("committed, not
   *  merged"). `at` is the activity it was read for, so any newer turn hides it until it is read again. */
  step?: TaskStep;
  /** The activity `step` was last read for (null answers included), so a quiet is read once. */
  stepAt?: number;
  /** Dropped: still claims its sessions (so they don't come back as a new task) but shows nowhere. */
  hidden?: boolean;
  /** The Today to-do or decision this task carries (`linkTasks` in lib/today.ts). Each closes the other. */
  today?: { date: string; kind: "todo" | "loop"; id: string };
  /** When he last pressed Reopen: a Today tick older than this doesn't close it again. */
  reopenedAt?: number;
  /** How the task came to be (2026-10-29: only tasks he starts are tasks). "ask" = the Ask line / New
   *  task / phone ＋ Task, "board" = a To-do card, "named" = he named a chat, "today" = a Today hand-off,
   *  "legacy" = derived from any chat before this rule (kept until it ages out). */
  origin?: "ask" | "board" | "named" | "today" | "legacy";
  /** Where the task stands, in the chat's words (task_report `note`), stored as note.md beside the record.
   *  What a chat picking the task up the next day reads first. */
  note?: string;
};
/** `dismissed`: sessions whose "Name this thread?" offer was waved off — asked once, never again. */
export type FlowState = { v: 2; threads: FlowThread[]; dismissed: string[] };

const empty = (): FlowState => ({ v: 2, threads: [], dismissed: [] });
export const fid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── Storage: one folder per task (§37, "task = contract + log", 2026-10-29) ───────────────────────
// Until 2026-10-29 every task lived in one flow.json that every writer read, changed and rewrote whole.
// Two writers on two different tasks (Haiku's done-list landing while a chat's task_report ticked
// another) could each write back the other's stale copy. And nothing said WHO changed a task, so a wrong
// tick or a wrong close could only be explained by reading transcripts.
//
//   <TASKS>/<id>/task.json    the record (the FlowThread minus `note`), rewritten only when it changed
//   <TASKS>/<id>/events.jsonl append-only: one line per change, with who made it (see `Actor`)
//   <TASKS>/<id>/note.md      where the task stands, in the chat's words (task_report `note`)
//   <TASKS>/_meta.json        { v: 3, dismissed, migratedAt }
//
// The API is unchanged (readFlow / mutateFlow / FlowState), so every caller works as before. A mutation
// now writes only the tasks it changed, so writers on different tasks no longer clobber each other.
// State is still the snapshot, not a fold of the log: the log is the audit trail for now.
const TASKS = process.env.MINAMI_TASKS_DIR || path.join(path.dirname(FILE), "tasks");
const META = path.join(TASKS, "_meta.json");
/** Who made a change, written on every event. "chat" = the task's own chat (task_report), "reader" =
 *  Minami's Haiku reading of a chat, "sensor" = git / the live build, "runner" = auto-continue. */
export type Actor = "thomas" | "chat" | "reader" | "sensor" | "today" | "runner" | "start" | "server";
type Meta = { v: 3; dismissed: string[]; migratedAt: number };

function atomic(file: string, body: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

function readLegacy(): FlowState {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    // v1 was the task/lead/sub model (retired the same day it was built); nothing in it carries over.
    if (!j || j.v !== 2) return empty();
    const s: FlowState = { ...empty(), ...j };
    for (const t of s.threads) if (t.dodSuggested?.length && !t.dod) {
      t.dod = t.dodSuggested.map((x, i) => ({ id: t.id + "-" + i, t: x, done: false })); t.dodPending = true; delete t.dodSuggested;
    }
    return s;
  } catch { return empty(); }
}

// Once, on the first read with no _meta.json: every flow.json record becomes a folder. flow.json is left
// where it is, untouched, so a rollback to the old build finds its store as it was.
function migrate() {
  const old = readLegacy();
  fs.mkdirSync(TASKS, { recursive: true });
  // Every flow.json record was derived from a chat or named; none says it was started as a task. They
  // stay ("legacy") so nothing open vanishes, and derived ones still age out after a week.
  for (const t of oneOwnerPerChat(old.threads)) writeTask({ ...t, origin: t.origin ?? (t.today ? "today" : t.queued ? "board" : t.auto ? "legacy" : "named") }, null, "server", "migrated from flow.json");
  atomic(META, JSON.stringify({ v: 3, dismissed: old.dismissed, migratedAt: Date.now() } satisfies Meta));
}

function readMeta(): Meta {
  if (!fs.existsSync(META)) migrate();
  try { return JSON.parse(fs.readFileSync(META, "utf8")); } catch { return { v: 3, dismissed: [], migratedAt: 0 }; }
}

function readTask(id: string): FlowThread | null {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(TASKS, id, "task.json"), "utf8")) as FlowThread;
    try { const n = fs.readFileSync(path.join(TASKS, id, "note.md"), "utf8").trim(); if (n) t.note = n; } catch { /* no note yet */ }
    return t;
  } catch { return null; }
}

export function readFlow(): FlowState {
  const meta = readMeta();
  const threads: FlowThread[] = [];
  let ids: string[] = [];
  try { ids = fs.readdirSync(TASKS).filter((x) => !x.startsWith(".") && !x.startsWith("_")); } catch { /* none yet */ }
  for (const id of ids) { const t = readTask(id); if (t) threads.push(t); }
  // Newest first, the order flow.json kept (writers `unshift`ed), which callers' "first claim" rules assume.
  threads.sort((a, b) => b.createdAt - a.createdAt);
  return { v: 2, threads: oneOwnerPerChat(threads), dismissed: meta.dismissed ?? [] };
}

/** What changed, in a line a person can read: items ticked / unticked / added / suggested, and closes. */
function diff(a: FlowThread | null, b: FlowThread): Record<string, unknown> {
  if (!a) return { created: true, title: b.title, origin: b.origin };
  const out: Record<string, unknown> = {};
  const was = new Map((a.dod ?? []).map((d) => [d.id, d]));
  const ticked = [], unticked = [], added = [], seen = [];
  for (const d of b.dod ?? []) {
    const p = was.get(d.id);
    if (!p) { added.push(d.t); if (d.done) ticked.push({ t: d.t, why: d.why, src: d.src }); continue; }
    if (d.done && !p.done) ticked.push({ t: d.t, why: d.why, src: d.src });
    if (!d.done && p.done) unticked.push(d.t);
    if (d.seen && d.seen.at !== p.seen?.at) seen.push({ t: d.t, why: d.seen.why });
  }
  if (ticked.length) out.ticked = ticked;
  if (unticked.length) out.unticked = unticked;
  if (added.length) out.added = added;
  if (seen.length) out.seen = seen;
  if (b.archived && !a.archived) out.closed = { auto: !!b.autoDone, why: b.closedWhy, ...(b.aborted ? { aborted: true } : {}) };
  if (!b.archived && a.archived) out.reopened = true;
  if (b.note !== a.note) out.note = true;
  if (b.step?.q !== a.step?.q) out.step = b.step?.q ?? null;
  if (b.title !== a.title) out.title = b.title;
  const keys = (Object.keys(b) as (keyof FlowThread)[]).filter((k) => !["dod", "updatedAt", "note", "step", "title", "archived"].includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (keys.length) out.fields = keys;
  return out;
}

function writeTask(t: FlowThread, before: FlowThread | null, by: Actor, why?: string) {
  const dir = path.join(TASKS, t.id);
  fs.mkdirSync(dir, { recursive: true });
  const { note, ...rec } = t;
  atomic(path.join(dir, "task.json"), JSON.stringify(rec, null, 1));
  if ((note ?? "") !== (before?.note ?? "")) atomic(path.join(dir, "note.md"), (note ?? "") + "\n");
  const d = diff(before, t);
  if (Object.keys(d).length) fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ at: Date.now(), by, ...(why ? { why } : {}), ...d }) + "\n");
}

/** Every change a task has had, oldest first: who, when, what. */
export function taskEvents(id: string): Record<string, unknown>[] {
  try {
    return fs.readFileSync(path.join(TASKS, id, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** The stored record for a task view, or undefined. A derived view ("s:<session>") never has a record
 *  under its own id — the record gets a fresh `fid()` — so it is found by the chats it holds. Looking it
 *  up by id alone is what made duplicates (🐛 2026-10-29, §37): `suggest`, the chat's `task_report` and the
 *  edit actions each missed the record another had just made, and each added its own. */
export function findStored(s: FlowState, v: { id: string; sessions: { id: string }[] }): FlowThread | undefined {
  const byId = s.threads.find((x) => x.id === v.id);
  if (byId || !v.id.startsWith("s:")) return byId;
  const ids = new Set(v.sessions.map((x) => x.id));
  return s.threads.find((x) => x.sessions.some((sid) => ids.has(sid)));
}

// A chat belongs to one task. Records written before `findStored` can claim the same chat two or three
// times, which showed as several cards with one chat and different done-lists. The one with the most
// met items keeps the chat (then the oldest); a loser left with no chats is dropped.
function oneOwnerPerChat(threads: FlowThread[]): FlowThread[] {
  const met = (t: FlowThread) => t.dod?.filter((d) => d.done).length ?? 0;
  const rank = [...threads].sort((a, b) => met(b) - met(a) || a.createdAt - b.createdAt);
  const owner = new Map<string, FlowThread>();
  for (const t of rank) for (const sid of t.sessions) if (!owner.has(sid)) owner.set(sid, t);
  return threads.flatMap((t) => {
    if (!t.sessions.length) return [t];
    const mine = t.sessions.filter((sid) => owner.get(sid) === t);
    if (!mine.length) return [];
    return [mine.length === t.sessions.length ? t : { ...t, sessions: mine }];
  });
}

// Only the tasks that changed are written (write-then-rename, per-process tmp name). A task removed from
// `threads` (a To-do card dropped) moves to `.trash/`, never deleted outright.
function writeFlow(before: FlowState, s: FlowState, by: Actor, why?: string) {
  const old = new Map(before.threads.map((t) => [t.id, t]));
  const snap = new Map(before.threads.map((t) => [t.id, JSON.stringify(t)]));
  for (const t of s.threads) if (snap.get(t.id) !== JSON.stringify(t)) writeTask(t, old.get(t.id) ?? null, by, why);
  const keep = new Set(s.threads.map((t) => t.id));
  for (const t of before.threads) if (!keep.has(t.id)) {
    try { fs.mkdirSync(path.join(TASKS, ".trash"), { recursive: true }); fs.renameSync(path.join(TASKS, t.id), path.join(TASKS, ".trash", t.id)); } catch { /* already gone */ }
  }
  if (JSON.stringify(before.dismissed) !== JSON.stringify(s.dismissed)) atomic(META, JSON.stringify({ ...readMeta(), dismissed: s.dismissed }));
}

/** The one way a task is moved to Done. Every close path used to set the fields by hand, and none
 *  cleared an item's `doing`, so a closed task kept an item "on now" for hours (4 archived tasks, and 3
 *  open ones 13–17h stale, in flow.json on 2026-10-29) and the board showed a done task as being worked.
 *  Lives here, not in lib/task-report.ts, so lib/today.ts can close a task without importing the session parser. */
export function closeTask(t: FlowThread, o: { auto?: boolean; why?: string; abort?: boolean } = {}) {
  t.archived = true; t.doneAt = Date.now(); t.auto = false; t.updatedAt = Date.now();
  if (o.auto) t.autoDone = true;
  if (o.abort) { t.aborted = true; t.autoDone = false; }
  if (o.why) t.closedWhy = o.why;
  t.dodPending = false;
  // A hold left on a closed task would re-close it the moment he reopens it (`ensure` honours holds).
  delete t.closeHeld;
  if (t.dod) t.dod = t.dod.map((d) => (d.doing ? (({ doing: _, ...r }) => r)(d) : d));
}

/** Read, change, write: the only way anything mutates the store. `by` is written on each task's event
 *  line, so a wrong tick or close can be traced to who made it. Returns what was written. */
export function mutateFlow(f: (s: FlowState) => void, by: Actor = "server", why?: string): FlowState {
  const before = readFlow();
  const s: FlowState = structuredClone(before);
  f(s);
  writeFlow(before, s, by, why);
  return s;
}
