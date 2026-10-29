// The Today plan runs itself (§26 "runs on its own"). Thomas, 2026-10-29: "today task is going to be done
// autonomously without waiting for my input to do each step … the today to do list etc".
//
// Before this, every to-do waited for a tap on "Do it with Minami", every answered question for "Hand to
// Minami", and a to-do with an `after` waited for him to notice its prerequisite had finished. Now a
// server-side tick does those taps, through the same handoff() the page calls — so placement (worktrees),
// the status contract and the ticks are exactly what a tapped hand-off gets. What it starts:
//   1. questions he already answered (his decision, just not carried out yet)
//   2. to-dos, in plan order, once their `after` prerequisites are ticked and their research is in
//   3. open questions the heartbeat put a recommendation on — Minami takes it unless the facts say otherwise
// Questions with no recommendation stay his. The hand-off prompt tells a runner-started chat that nobody is
// watching: outward-facing work is made ready and handed back as "TODAY: yours", never a question it waits on.
//
// Polls rather than subscribing, for the reason lib/agents/runner.ts gives: a server-side subscribe() counts
// as a connected client and switches off the idle reaper. A minute is fast enough for work measured in
// tens of minutes.
//
// Only the live server runs it: the :3001 preview server sets MINAMI_AUTOPILOT_DISABLE=1 and would
// otherwise start every task twice. MINAMI_TODAY_AUTORUN=0 turns it off for the install; the page's
// switch turns it off for one day (`day.autorun = false`).
import { handoff, localDate, readDay, reconcile, unmetDeps, RESEARCH_STALL_MS, type TodayDay } from "@/lib/today";

const EVERY_MS = 60_000;
/** Chats working at once. Two keeps a morning's plan moving without six chats fighting one repo and one
 *  account's rate limit; a chat stopped on a question doesn't hold a slot. */
const MAX_RUNNING = Math.max(1, Number(process.env.MINAMI_TODAY_AUTORUN_MAX) || 2);
/** A runaway guard, not a plan size: the heartbeat writes 4–8 to-dos; to-dos he adds through the day count too. */
const DAY_CAP = Math.max(1, Number(process.env.MINAMI_TODAY_AUTORUN_CAP) || 20);
/** A start that failed (missing folder, the chat didn't come up) is retried after this, not every tick. */
const RETRY_MS = 30 * 60e3;

const G = globalThis as unknown as { __minamiTodayRun?: NodeJS.Timeout; __minamiTodayFail?: Map<string, number> };
const failed = (G.__minamiTodayFail ??= new Map());
let ticking = false;

export function startTodayAutorun(): void {
  if (process.env.MINAMI_AUTOPILOT_DISABLE === "1" || process.env.MINAMI_TODAY_AUTORUN === "0") return;
  if (G.__minamiTodayRun) return;
  G.__minamiTodayRun = setInterval(() => { void tick(); }, EVERY_MS);
  G.__minamiTodayRun.unref?.();
  // Not at boot itself: liveStats() is empty until panes reattach, which would read every running chat as
  // stopped and start a third one. One interval in, the picture is real.
}

/** Run a tick now (the page's switch was turned on) — a no-op if one is already going. */
export function kickTodayAutorun(): void { if (G.__minamiTodayRun) setTimeout(() => { void tick(); }, 2_000); }

type Next = { kind: "todo" | "loop"; id: string; how: "do" | "decide"; answer?: string | string[]; label: string };

/** What the runner would start next on this day, in order. Pure over the day; exported for the page's
 *  "runs on its own" line and for testing. */
export function queue(day: TodayDay): Next[] {
  const out: Next[] = [];
  for (const l of day.loops)
    if (l.resolved && !l.handoff && !l.done) out.push({ kind: "loop", id: l.id, how: "decide", answer: l.resolved.answer, label: l.question });
  for (const t of day.todos) {
    if (t.done || t.handoff || unmetDeps(day, t).length) continue;
    // A to-do he just typed is still being researched into a folder and a plan; starting it now would run
    // it in ~ with only his one line. A stalled research run doesn't hold it forever.
    if (t.research?.state === "running" && Date.now() - Date.parse(t.research.at) < RESEARCH_STALL_MS) continue;
    out.push({ kind: "todo", id: t.id, how: "do", label: t.title || t.text });
  }
  for (const l of day.loops)
    if (!l.resolved && !l.handoff && typeof l.recommended === "number" && l.options[l.recommended]) out.push({ kind: "loop", id: l.id, how: "decide", label: l.question });
  return out;
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const date = localDate();
    if (readDay(date).autorun === false) return;
    // reconcile() first: it ticks what finished since the last look, which is what frees a dependent.
    const { day, status } = await reconcile(date);
    // "running" = the heartbeat is writing the plan right now; "none" = there is no plan yet.
    if (day.status === "running" || day.status === "none" || day.autorun === false) return;
    const items = [...day.todos, ...day.loops];
    const running = items.filter((x) => x.handoff && status[x.id]?.busy && !status[x.id]?.need).length;
    let started = items.filter((x) => x.handoff?.auto).length;
    let free = MAX_RUNNING - running;
    for (const n of queue(day)) {
      if (free <= 0 || started >= DAY_CAP) break;
      const key = `${date}:${n.kind}:${n.id}`;
      if (Date.now() - (failed.get(key) ?? 0) < RETRY_MS) continue;
      const r = await handoff(date, { kind: n.kind, id: n.id, how: n.how, answer: n.answer, auto: true });
      if (!r.ok) {
        failed.set(key, Date.now());
        console.warn(`[today-autorun] couldn't start "${n.label.slice(0, 60)}": ${r.error}`);
        continue;
      }
      console.log(`[today-autorun] started "${n.label.slice(0, 60)}" → ${r.sessionId}`);
      free--; started++;
    }
  } catch (e) {
    console.warn("[today-autorun] tick failed:", e);
  } finally { ticking = false; }
}
