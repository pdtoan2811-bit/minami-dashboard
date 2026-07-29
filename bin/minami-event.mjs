#!/usr/bin/env node
// The ONLY writer of the Minami event log. Everything that wants to alert Thomas — deploy.sh,
// task.mjs, anything future — comes through here, as a module import or as a CLI.
//
// WHY A FILE, AND WHY NOT THE SERVER
// The most important event this log carries is "the deploy finished", and the deploy *restarts
// next-server*. An event held in the server's memory, or pushed over an open SSE stream, dies with
// the process that was supposed to deliver it — the one moment you most need to be told something is
// the one moment the messenger is guaranteed to be dead. So the producer must outlive the server
// (a plain file append from a detached bash script does), and the consumer must be able to catch up
// *after* it reconnects. That is the whole design: nothing in the Next process ever writes here;
// lib/events.ts only reads.
//
// It also means alerts still get recorded with :3000 down entirely — the same property bin/task.mjs
// deliberately has, and for the same reason: the tools have to work when the app doesn't.
//
//   node bin/minami-event.mjs <kind> <level> <title> [body]
//   emit({ kind, level, title, body, meta })       // from another node script
//
// level: info | success | warn | error   (drives the dot colour in the bell, nothing else)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Kept in sync by hand with lib/events.ts — one string, and the reader must not be able to import
// from bin/ (it ships in the server bundle).
export const EVENTS_FILE =
  process.env.MINAMI_EVENTS || path.join(os.homedir(), ".minami", "events.jsonl");

const KEEP = 500;  // what a trim leaves behind
const CEIL = 600;  // trim only when we cross this, so trimming is ~1 write in 100

/** Append one event. Never throws: an alert failing to record must not fail the deploy it describes. */
export function emit({ kind, level = "info", title, body = "", meta = undefined }) {
  try {
    const ev = {
      // ts-then-random: the id sorts chronologically for free, and stays unique across the several
      // unrelated processes (deploy.sh, task.mjs, a preview build) that append here concurrently.
      id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
      ts: Date.now(),
      kind,
      level,
      title: String(title || "").slice(0, 200),
      // Bodies carry real output (a type error, a verify table), so they're generous but bounded —
      // one runaway build log must not make the whole log unreadable.
      body: String(body || "").slice(0, 1200),
      ...(meta ? { meta } : {}),
    };
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    // O_APPEND on a single small write is atomic on macOS, which is what makes concurrent producers
    // safe without a lock.
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(ev) + "\n");
    trim();
    return ev;
  } catch { return null; }
}

/** Bound the file. Rewrite-and-rename, so a reader never sees a half-written log — at the cost of
 *  losing an append that lands inside the rename window. That trade is deliberate: it happens once
 *  per hundred events, and a dropped alert is cheaper than a corrupt one. */
function trim() {
  try {
    const lines = fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
    if (lines.length <= CEIL) return;
    const tmp = `${EVENTS_FILE}.tmp`;
    fs.writeFileSync(tmp, lines.slice(-KEEP).join("\n") + "\n");
    fs.renameSync(tmp, EVENTS_FILE);
  } catch { /* a log that can't be trimmed is still a log */ }
}

// --- CLI ---------------------------------------------------------------------------------------
// Invoked from bash (deploy.sh). Body arrives on argv or, if omitted, on stdin — verify tables and
// build output are multi-line and would be miserable to quote as an argument.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, level, title, ...rest] = process.argv.slice(2);
  if (!kind || !title) {
    console.error("usage: minami-event.mjs <kind> <level> <title> [body]   (body may come from stdin)");
    process.exit(2);
  }
  let body = rest.join(" ");
  if (!body && !process.stdin.isTTY) {
    try { body = fs.readFileSync(0, "utf8"); } catch { /* no stdin */ }
  }
  const ev = emit({ kind, level, title, body });
  process.exit(ev ? 0 : 1);
}
