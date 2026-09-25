// Per-ask progress and ETA — "how far along is the thing I just asked for, and when will it land".
//
// Shared (server + client), pure, no node imports. The server (lib/agent/manager.ts) tracks the live
// ask's plan as plan tool calls stream in and ships a `TaskProgress` inside ActivityState; the pane and
// the bento tile both render it through components/TaskProgressBar.tsx. One derivation, two surfaces.
//
// ── What the bar is allowed to claim ──────────────────────────────────────────────────────────────
// The unit is a PLAN ITEM the model wrote (TodoWrite / TaskCreate), never a tool call and never time
// alone. "3 of 5 steps done" is a fact read off the transcript; "62%" is only ever that fact plus a
// bounded amount of credit for the step in flight. No plan → no bar: an elapsed clock already exists
// for that case, and a bar that fills on a timer is the fake progress this feature replaces.
//
// ── The ETA is a pace, and says so ─────────────────────────────────────────────────────────────────
// Remaining steps × observed ms-per-step. The pace comes from THIS ask once it has finished a step, and
// before then from earlier asks in the same session (`priorPaceMs`) — the same model on the same repo is
// the best prior there is. With neither, there is no ETA rather than a made-up one. Every value here is
// a fixed timestamp, not a countdown, so the 1.5s tile poll sees an unchanged object between plan
// updates and the grid doesn't re-render (see liveActivity in manager.ts for why that matters).

export type PlanStatus = "pending" | "in_progress" | "completed";

/** One plan item as the server tracks it: the model's words plus the two moments that make a pace. */
export type PlanStep = { key: string; title: string; status: PlanStatus; startedAt?: number; doneAt?: number };

export type TaskProgress = {
  done: number;
  total: number;
  /** The step in flight, in the model's own words — the "semantic" half of the bar. */
  now?: string;
  /** When the ask began — the anchor for pace before any step has finished. */
  since: number;
  /** When the in-flight step began, for partial credit. */
  stepSince?: number;
  /** When the most recent step finished. */
  lastDoneAt?: number;
  /** Observed ms per step. Absent → no ETA. */
  paceMs?: number;
  /** Where the pace came from: this ask's own finished steps, or earlier asks in the session. */
  paceFrom?: "this" | "session";
  /** Projected finish, as a wall-clock time. */
  etaAt?: number;
};

/** The most credit an unfinished step can earn from elapsed time. Below 1 so a step that runs long
 *  never makes the bar claim it finished — only a `completed` status can do that. */
const MAX_PARTIAL = 0.85;

/** Collapse a plan into what the bar needs. `priorPaceMs` is the session's pace from earlier asks. */
export function progressOf(steps: PlanStep[], since: number, priorPaceMs?: number): TaskProgress | null {
  if (!steps.length) return null;
  const done = steps.filter((s) => s.status === "completed");
  const live = steps.find((s) => s.status === "in_progress");
  const lastDoneAt = done.reduce<number | undefined>((m, s) => (s.doneAt && (!m || s.doneAt > m) ? s.doneAt : m), undefined);

  // This ask's own pace, once it has one: time from the ask to its latest finished step, over the steps
  // finished by then. Includes the reading/planning before step 1, which is correct — that overhead is
  // part of what the remaining steps will also cost, spread thin.
  const own = done.length && lastDoneAt ? (lastDoneAt - since) / done.length : undefined;
  const paceMs = own && own > 0 ? own : priorPaceMs && priorPaceMs > 0 ? priorPaceMs : undefined;
  const remaining = steps.length - done.length;
  const anchor = lastDoneAt ?? since;

  return {
    done: done.length,
    total: steps.length,
    ...(live ? { now: live.title, ...(live.startedAt ? { stepSince: live.startedAt } : {}) } : {}),
    since,
    ...(lastDoneAt ? { lastDoneAt } : {}),
    ...(paceMs ? { paceMs: Math.round(paceMs), paceFrom: own ? "this" as const : "session" as const, etaAt: Math.round(anchor + paceMs * remaining) } : {}),
  };
}

/** The bar's fill at time `now`, 0..1. Finished steps count whole; the step in flight earns elapsed/pace,
 *  capped at MAX_PARTIAL — so the bar moves between plan updates without ever overstating. */
export function fractionAt(p: TaskProgress, now: number): number {
  if (!p.total) return 0;
  let partial = 0;
  if (p.now && p.paceMs && p.done < p.total) {
    const from = Math.max(p.stepSince ?? 0, p.lastDoneAt ?? p.since);
    partial = Math.min(MAX_PARTIAL, Math.max(0, now - from) / p.paceMs);
  }
  return Math.min(1, (p.done + partial) / p.total);
}

/** "~4m left" / "~40s left" / "running 2m over" — the ETA as a phrase, or null with no pace. */
export function etaPhrase(p: TaskProgress, now: number): string | null {
  if (!p.etaAt || p.done >= p.total) return null;
  const left = p.etaAt - now;
  if (left >= 0) return `~${fmtShort(left)} left`;
  // Past the projection. Said plainly rather than clamped to "any moment": a step that is taking three
  // times the pace is information, and hiding it is the reassuring lie this bar exists to avoid.
  return -left < 15_000 ? "finishing" : `${fmtShort(-left)} over estimate`;
}

export function fmtShort(ms: number): string {
  const s = Math.round(ms / 1000);
  // Seconds up to 100s: rounding 90s to "2m" overstates the wait by a third, at the one scale where
  // the difference is visible.
  if (s < 100) return `${Math.max(1, s)}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
