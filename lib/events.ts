// Reader for the Minami event log. READ-ONLY on purpose — see bin/minami-event.mjs for why the
// server is never allowed to write here: the events that matter most are produced by processes that
// outlive next-server precisely because they kill it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type EventLevel = "info" | "success" | "warn" | "error";

export type MinamiEvent = {
  id: string;
  ts: number;
  kind: string;      // "deploy" | "build" | … — grouping only, the UI doesn't switch on it
  level: EventLevel;
  title: string;
  body?: string;
  meta?: Record<string, unknown>;
};

/** Must match bin/minami-event.mjs. The reader can't import from bin/ — that file is a CLI with a
 *  top-level side effect, and it would be pulled into the server bundle. */
export const EVENTS_FILE =
  process.env.MINAMI_EVENTS || path.join(os.homedir(), ".minami", "events.jsonl");

/**
 * The newest `limit` events, oldest-first, optionally only those strictly after `afterTs`.
 *
 * Filtering by timestamp rather than by a line offset is what makes this survive a trim: an offset
 * cursor silently rewinds by 100 events the moment the file is rewritten, replaying alerts you had
 * already read. A timestamp cursor just keeps working.
 */
export function readEvents({ limit = 50, afterTs = 0 } = {}): MinamiEvent[] {
  let raw: string;
  try { raw = fs.readFileSync(EVENTS_FILE, "utf8"); }
  catch { return []; }  // no log yet is the normal state on a fresh box, not an error

  const out: MinamiEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as MinamiEvent;
      // A half-written or hand-edited line must not take the whole feed down with it.
      if (typeof ev?.ts !== "number" || !ev.id) continue;
      if (ev.ts > afterTs) out.push(ev);
    } catch { /* skip the bad line, keep the log */ }
  }
  // Producers append concurrently, so the file is *nearly* sorted, not sorted. Cheap to make exact.
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-limit);
}
