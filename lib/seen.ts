// When each chat was last SEEN by the user, on any device (§23) — the inbox's "New" group.
//
// Server-side because the user reads the same chat on the Mac, the Find N5 and the Flip: an unread
// mark kept in one browser's storage says "new" on the phone for a reply already read at the desk,
// and an unread dot that can't be trusted is the "9+" bell again. "Seen" means the chat's final
// message was on screen (the client decides that), not that the chat was opened.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = process.env.MINAMI_SEEN_FILE || path.join(os.homedir(), ".minami", "seen.json");
let cache: Record<string, number> | null = null;

// `__floor` is when tracking began. Anything that ended before it counts as read: without a floor, the
// first day of this feature would mark every chat of the last month "new" at once.
function load(): Record<string, number> {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { cache = {}; }
  if (!cache!.__floor) { cache!.__floor = Date.now(); persist(cache!); }
  return cache!;
}

function persist(m: Record<string, number>) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(m));
  fs.renameSync(tmp, FILE);
}

export function seenAll(): { seen: Record<string, number>; floor: number } {
  const { __floor, ...seen } = load();
  return { seen, floor: __floor };
}

export function markSeen(sessionId: string, at = Date.now()): void {
  const m = load();
  if ((m[sessionId] || 0) >= at) return;
  m[sessionId] = at;
  // Bounded: keep the newest 2000 — older chats are idle by any definition, unread or not.
  const keys = Object.keys(m).filter((k) => k !== "__floor");
  if (keys.length > 2000) for (const k of keys.sort((a, b) => m[a] - m[b]).slice(0, keys.length - 2000)) delete m[k];
  persist(m);
}
