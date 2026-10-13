// What a Today to-do's hand-off actually came to (§26) — read from the chat's own transcript.
//
// ⚠️ WHY NOT THE THREAD LEDGER. The hand-off prompt asks every chat to end on a status line
// ("TODAY: done" …) and vault bin/today-sync.mjs was meant to read it — from the ledger, which stores
// the first 320 characters of each reply. The status line is the LAST line. On 2026-10-13 all four
// hand-offs ended "TODAY: done" and one got ticked (by other evidence); the line was never in the data
// the judge was shown. The transcript has the whole reply, so the line is parsed here, without a model.
//
// ⚠️ "DONE" IS NOT ONE THING. A chat's "done" meant "my part is done" as often as "the outcome
// happened": the price-cut draft was finished and waiting for Thomas to publish; the updated-date check
// said done and then reported Docker wasn't running. So the contract has three words, and the page
// shows them as different states: done (tick it), yours (Minami's part is over — here is what only you
// can do), blocked (here is why).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Outcome = {
  state: "done" | "yours" | "blocked";
  /** The rest of the status line: what he has to do, or what blocks it. */
  why: string;
  at: number;
  /** The chat wrote more after this line without a new one — the line may no longer be true
   *  (2026-10-13: "TODAY: done", then a follow-up saying Docker wasn't running). Never ticks. */
  stale?: boolean;
};
export type Drift = {
  /** Minutes the chat has been working in total — set only past LONG_MIN. */
  longMin?: number;
  /** Files it wrote outside its to-do's folder (and outside scratch / config dirs). */
  outside?: string[];
};
export type HandoffReport = { outcome: Outcome | null; drift: Drift | null; lastAt: number | null };

/** Past this, a hand-off is flagged "running long". The discount-calendar chat ran 17½ h (2026-10-12)
 *  and wandered into the ADR and the Today page's own code; nothing on screen said so. Two hours is
 *  long for any one to-do the heartbeat writes (their estimates top out around 40 min). */
const LONG_MIN = 120;

const PROJECTS = path.join(os.homedir(), ".claude", "projects");
/** Writes that are never "leaving the task": scratch, harness/dashboard state, and the vault — every
 *  session is asked to capture decisions there (global CLAUDE.md), so a note in it is not drift. */
const IGNORED = [os.tmpdir(), "/tmp/", "/private/tmp/", path.join(os.homedir(), ".claude"), path.join(os.homedir(), ".minami"),
  process.env.SECOND_BRAIN_DIR || path.join(os.homedir(), "secondBrain")];
/** One or two edits next door is a task using its tools (the price-cut chat fixed the cover renderer
 *  in ~/ecvision it renders with). The discount-calendar chat's five, ADR included, was the drift. */
const OUTSIDE_MIN = 3;

const STATUS = /^\s*TODAY:\s*(done|yours|blocked)\b\s*(?:[—–-]+\s*)?(.*)$/i;

/** Transcript path per session id. A miss is looked up again next time (the file appears on first write). */
const where = new Map<string, string>();
function findTranscript(sid: string): string | null {
  const hit = where.get(sid);
  if (hit && fs.existsSync(hit)) return hit;
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(PROJECTS, d, `${sid}.jsonl`);
    if (fs.existsSync(p)) { where.set(sid, p); return p; }
  }
  return null;
}

type Parsed = { outcome: Outcome | null; lastAt: number | null; firstAt: number | null; writes: string[] };
/** Parsed once per file version: a long hand-off's transcript is megabytes, and /today is polled. */
const cache = new Map<string, { mtime: number; size: number; parsed: Parsed }>();

function parse(file: string): Parsed {
  const st = fs.statSync(file);
  const c = cache.get(file);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.parsed;
  let outcome: Outcome | null = null;
  let texts = 0, outcomeAtText = -1;
  let firstAt: number | null = null, lastAt: number | null = null;
  const writes = new Set<string>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let o: { type?: string; timestamp?: string; message?: { content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    const at = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(at)) { firstAt ??= at; lastAt = at; }
    if (o.type !== "assistant" || !Array.isArray(o.message?.content)) continue;
    for (const b of o.message!.content as { type?: string; text?: string; name?: string; input?: Record<string, unknown> }[]) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        texts++;
        // The LAST status line wins, across the whole chat: a later "blocked" corrects an earlier
        // "done", and a follow-up turn can finish what was blocked.
        for (const l of b.text.split("\n")) {
          const m = l.replace(/[*_`]/g, "").match(STATUS);
          if (m) { outcome = { state: m[1].toLowerCase() as Outcome["state"], why: m[2].trim().slice(0, 200), at: Number.isFinite(at) ? at : Date.now() }; outcomeAtText = texts; }
        }
      }
      if (b?.type === "tool_use" && (b.name === "Edit" || b.name === "Write" || b.name === "NotebookEdit")) {
        const p = String(b.input?.file_path ?? b.input?.notebook_path ?? "");
        if (p) writes.add(p);
      }
    }
  }
  if (outcome && texts > outcomeAtText) outcome.stale = true;
  const parsed = { outcome, lastAt, firstAt, writes: [...writes] };
  cache.set(file, { mtime: st.mtimeMs, size: st.size, parsed });
  return parsed;
}

const expand = (f: string) => f.replace(/^~(?=\/|$)/, os.homedir());
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** One hand-off's report. `folders` are where its work belongs: the to-do's folder and the worktree
 *  the chat ran in, if it was isolated. */
export function handoffReport(sessionId: string, folders: (string | undefined)[], busy: boolean): HandoffReport {
  const file = findTranscript(sessionId);
  if (!file) return { outcome: null, drift: null, lastAt: null };
  let r: Parsed;
  try { r = parse(file); } catch { return { outcome: null, drift: null, lastAt: null }; }
  const homes = folders.filter((f): f is string => !!f).map((f) => real(expand(f)));
  const outside = r.writes.filter((w) => {
    const p = real(w);
    return !homes.some((h) => p === h || p.startsWith(h + path.sep)) && !IGNORED.some((i) => p.startsWith(i));
  });
  const minutes = r.firstAt && r.lastAt ? Math.round((r.lastAt - r.firstAt) / 60_000) : 0;
  const drift: Drift = {};
  // Long counts only while it's still going or never reported — a finished long job is history.
  if (minutes >= LONG_MIN && (busy || !r.outcome)) drift.longMin = minutes;
  if (outside.length >= OUTSIDE_MIN) drift.outside = outside.slice(0, 5).map((p) => p.replace(os.homedir(), "~"));
  return { outcome: r.outcome, drift: drift.longMin || drift.outside ? drift : null, lastAt: r.lastAt };
}

/** The status line, as the hand-off prompt asks for it. One place, so the parser and the ask agree. */
export const STATUS_CONTRACT =
  `End your final message with exactly one status line, on its own line — my Today page reads it:\n` +
  `"TODAY: done" — the outcome happened (published, committed, rendered, sent, fixed).\n` +
  `"TODAY: yours — <the one thing only I can do, in a few words>" — your part is finished but the outcome needs me (e.g. "publish it in /admin/content").\n` +
  `"TODAY: blocked — <what blocks it, in under 8 words>" — it can't be finished now. Name the blocker the same way every time (e.g. "no prod CMS target"), so the page can group tasks stuck on the same thing.\n` +
  `If you write again later in this chat — a follow-up, a watcher finishing, a correction — end that message with the status line again (changed or not), so the latest message always carries it.`;
