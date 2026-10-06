// FOCUS — the chats you chose to keep under your thumb on the phone (§23, round 9 of the phone pitch).
//
// The phone's dock used to be "recently visited": whatever you touched last, which on a day with seven
// chats across four projects meant the dock was never the set you were actually juggling. Focus is a
// deliberate, ordered set of at most FOCUS_MAX session ids, pinned and unpinned by hand.
//
// Server-side for the same reason as lib/seen.ts: the Flip, the Find N5 and the Mac must agree on it — a
// dock that differs per device is a second inbox to keep in your head.
//
// The rules the three-designer review settled (docs/knowledge/23-mobile.md):
// - Nothing is ever evicted FOR you while it's running or waiting on you. When the set is full, the
//   client offers a done chat to step out (with Undo) and only asks when all five are still active —
//   that decision needs live state the client already has, so this module just refuses a sixth.
// - Unpinning is not archiving: the chat stays in every list, sorted by urgency like everything else.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FOCUS_MAX = 5;
const FILE = process.env.MINAMI_FOCUS_FILE || path.join(os.homedir(), ".minami", "focus.json");
let cache: string[] | null = null;

function load(): string[] {
  if (cache) return cache;
  try {
    const v = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache = Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, FOCUS_MAX) : [];
  } catch { cache = []; }
  return cache!;
}

function persist(ids: string[]) {
  cache = ids;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(ids));
  fs.renameSync(tmp, FILE);
}

export function focusList(): string[] {
  return [...load()];
}

export type FocusResult = { ok: true; focus: string[] } | { ok: false; full: true; focus: string[] };

/** Pin `id`, optionally swapping `swapOut` out in the same write (the "dock is full" path, so the two
 *  halves of a swap can't be split by a second device's request landing between them). */
export function pin(id: string, swapOut?: string): FocusResult {
  let ids = load().filter((x) => x !== id);
  if (swapOut) ids = ids.filter((x) => x !== swapOut);
  if (ids.length >= FOCUS_MAX) return { ok: false, full: true, focus: [...load()] };
  persist([...ids, id]);
  return { ok: true, focus: focusList() };
}

export function unpin(id: string): FocusResult {
  persist(load().filter((x) => x !== id));
  return { ok: true, focus: focusList() };
}
