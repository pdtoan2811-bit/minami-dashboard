import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Which chats the Today page started (§26 hand-offs), for the phone inbox's Today switch (§23).
//
// Read from Today's own records — each handed-off to-do or loop stores `handoff.sessionId` — rather
// than from the chat's title. Hand-offs open with "Today · <task>", but the rolling title (§5h)
// renames a chat after three asks, so the prefix is gone from exactly the long-running chats that
// crowd the inbox. Standalone on purpose: lib/today.ts pulls in the agent manager, and the sessions
// route is polled by every open tab.
const DIR = process.env.MINAMI_TODAY_DIR || path.join(os.homedir(), ".minami/today");

let cache: { sig: string; ids: Set<string> } | null = null;

export function todaySessionIds(): Set<string> {
  let files: string[];
  try { files = fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)); } catch { return new Set(); }
  // Re-read only when a day file changed: the sessions route runs about once a second.
  const stamps = files.map((f) => { try { return `${f}:${fs.statSync(path.join(DIR, f)).mtimeMs}`; } catch { return f; } });
  const sig = stamps.join("|");
  if (cache && cache.sig === sig) return cache.ids;
  const ids = new Set<string>();
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
      for (const x of [...(d.todos || []), ...(d.loops || [])]) if (x?.handoff?.sessionId) ids.add(x.handoff.sessionId);
    } catch { /* a day file mid-write — the next change re-reads it */ }
  }
  cache = { sig, ids };
  return ids;
}
