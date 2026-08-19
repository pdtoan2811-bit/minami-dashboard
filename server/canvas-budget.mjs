// MONTHLY SPEND CEILING for the meeting bot.
//
// Auto-join means cost runs without anyone deciding to spend it, and the failure mode is quiet: a bot
// left in a forgotten recurring invite bills $0.50/hour indefinitely, and nobody notices until the
// invoice. Recall's own `automatic_leave` catches the empty-room case; it does not catch a real
// meeting nobody meant to record, and it cannot know about a monthly budget at all.
//
// ── Why a file and not a database ───────────────────────────────────────────────────────────────
// One number per month. A JSON file next to the rest of Minami's state is the honest size of this
// problem, it survives a restart, and it is readable with `cat` at the moment you most want to know
// what it says.
//
// ── The two thresholds ──────────────────────────────────────────────────────────────────────────
//   WARN   Minami tells you, and keeps working. A warning that blocks is just a block.
//   STOP   dispatch is refused. This is deliberately a HARD stop rather than a warning that escalates:
//          the whole point is to bound the number nobody is watching.
//
// Spend is recorded when a meeting ENDS, because that is when the duration is known — so a single
// enormous meeting can overshoot the ceiling once. Bounding that would mean polling cost mid-call for
// a number that only matters afterwards.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const FILE = process.env.CANVAS_BUDGET_FILE || `${process.env.HOME}/.minami/canvas-budget.json`;
const LIMIT = Number(process.env.CANVAS_BUDGET_USD || 50);
const WARN_AT = 0.8;

/** Recall's published rate. The model legs are measured per meeting and added on top.
 *
 *  For sizing: measured across real meetings on chirp-3, the model legs run ~$0.51/meeting-hour, so
 *  the true all-in figure is ~$1.00/meeting-hour — roughly DOUBLE the ~$0.56 estimated when the ASR
 *  was whisper. A $50 ceiling is therefore about 49 meeting-hours a month, not 89. */
export const BOT_USD_PER_HOUR = 0.5;

const month = () => new Date().toISOString().slice(0, 7); // YYYY-MM

function load() {
  try {
    const d = JSON.parse(readFileSync(FILE, "utf8"));
    // A new month starts at zero rather than carrying the old total forward. Keyed by month so a
    // stale file cannot silently block dispatch forever.
    return d.month === month() ? d : { month: month(), usd: 0, meetings: 0 };
  } catch {
    return { month: month(), usd: 0, meetings: 0 };
  }
}

function save(d) {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(d, null, 2));
  } catch (e) {
    // Never let bookkeeping stop a meeting: a lost record costs accuracy, a thrown error costs the
    // call. It is logged so a persistently unwritable path is visible rather than silent.
    console.error("[budget] could not write:", e.message);
  }
}

/** Ask before dispatching. Returns { ok, spent, limit, reason }. */
export function checkBudget() {
  const d = load();
  const spent = d.usd;
  if (LIMIT > 0 && spent >= LIMIT) {
    return { ok: false, spent, limit: LIMIT, reason: `monthly ceiling reached ($${spent.toFixed(2)} of $${LIMIT})` };
  }
  const warn = LIMIT > 0 && spent >= LIMIT * WARN_AT
    ? `$${spent.toFixed(2)} of $${LIMIT} used this month`
    : null;
  return { ok: true, spent, limit: LIMIT, warn };
}

/** Record what a finished meeting cost. `modelUsd` comes from the ingest summary. */
export function recordMeeting({ minutes = 0, modelUsd = 0 }) {
  const d = load();
  d.usd += (minutes / 60) * BOT_USD_PER_HOUR + modelUsd;
  d.meetings += 1;
  save(d);
  return d;
}
