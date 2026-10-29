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
  gateBy?: "thomas" };
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
};
/** `dismissed`: sessions whose "Name this thread?" offer was waved off — asked once, never again. */
export type FlowState = { v: 2; threads: FlowThread[]; dismissed: string[] };

const empty = (): FlowState => ({ v: 2, threads: [], dismissed: [] });
export const fid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function readFlow(): FlowState {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    // v1 was the task/lead/sub model (retired the same day it was built); nothing in it carries over.
    if (!j || j.v !== 2) return empty();
    const s: FlowState = { ...empty(), ...j };
    for (const t of s.threads) if (t.dodSuggested?.length && !t.dod) {
      t.dod = t.dodSuggested.map((x, i) => ({ id: t.id + "-" + i, t: x, done: false })); t.dodPending = true; delete t.dodSuggested;
    }
    s.threads = oneOwnerPerChat(s.threads);
    return s;
  } catch { return empty(); }
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

// Write-then-rename with a per-process tmp name: two servers writing at once each land a whole file,
// never an interleaving of both.
function writeFlow(s: FlowState) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, FILE);
}

/** The one way a task is moved to Done. Every close path used to set the fields by hand, and none
 *  cleared an item's `doing`, so a closed task kept an item "on now" for hours (4 archived tasks, and 3
 *  open ones 13–17h stale, in flow.json on 2026-10-29) and the board showed a done task as being worked.
 *  Lives here, not in lib/task-report.ts, so lib/today.ts can close a task without importing the session parser. */
export function closeTask(t: FlowThread, o: { auto?: boolean; why?: string } = {}) {
  t.archived = true; t.doneAt = Date.now(); t.auto = false; t.updatedAt = Date.now();
  if (o.auto) t.autoDone = true;
  if (o.why) t.closedWhy = o.why;
  t.dodPending = false;
  // A hold left on a closed task would re-close it the moment he reopens it (`ensure` honours holds).
  delete t.closeHeld;
  if (t.dod) t.dod = t.dod.map((d) => (d.doing ? (({ doing: _, ...r }) => r)(d) : d));
}

/** Read, change, write: the only way anything mutates the file. Returns what was written. */
export function mutateFlow(f: (s: FlowState) => void): FlowState {
  const s = readFlow();
  f(s);
  writeFlow(s);
  return s;
}
