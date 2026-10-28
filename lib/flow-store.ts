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
export type FlowDod = { id: string; t: string; done: boolean; at?: number; by?: "minami"; why?: string };
export type FlowThread = {
  id: string; title: string; project: string; cwd: string;
  /** Session ids, oldest first. A session belongs to at most one stored thread. */
  sessions: string[];
  dod?: FlowDod[];
  /** The DoD is Minami's proposal, not yet kept (Thomas, 2026-10-28: "Minami suggests, you tap"). It
   *  still shows and still tracks progress — a hidden suggestion read as "DoD is not there". */
  dodPending?: boolean;
  /** Retired shape of the proposal (a bare list); folded into `dod` + `dodPending` on read. */
  dodSuggested?: string[];
  /** Stored only to hold Minami's done-list on a derived thread: ages out after a week like one. */
  auto?: boolean;
  /** A To-do card: written down, no chat started yet. `sessions` is empty until Start. */
  queued?: boolean;
  /** Last activity Minami checked the DoD against; a newer reply means check again. */
  evalAt?: number;
  /** When a done-list was asked for and none came back, so it isn't asked for on every poll. */
  dodTriedAt?: number;
  createdAt: number; updatedAt: number; archived?: boolean; doneAt?: number;
  /** Archived by itself: the last done-item got ticked (by Minami or him). The page celebrates these
   *  once, and a reply in the chat afterwards brings the task back. */
  autoDone?: boolean;
  /** Dropped: still claims its sessions (so they don't come back as a new task) but shows nowhere. */
  hidden?: boolean;
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
    return s;
  } catch { return empty(); }
}

// Write-then-rename with a per-process tmp name: two servers writing at once each land a whole file,
// never an interleaving of both.
function writeFlow(s: FlowState) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, FILE);
}

/** Read, change, write: the only way anything mutates the file. Returns what was written. */
export function mutateFlow(f: (s: FlowState) => void): FlowState {
  const s = readFlow();
  f(s);
  writeFlow(s);
  return s;
}
