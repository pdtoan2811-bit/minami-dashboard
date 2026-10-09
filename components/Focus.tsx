"use client";
// The phone's dock and progress sheet, built around FOCUS (§23, phone pitch rounds 6–8).
//
// Settled by a three-designer review (Android/foldables, messaging, agent-ops) — the reasons, so the next
// edit doesn't undo them:
// - The dock IS the focus set: the chats you pinned, not the ones you touched last. It never grows past
//   the current chat + one visitor + two pins + "+N": every mechanic wanted a chip, and a 412px bar
//   with six chips is a row of 40px guesses.
// - A VISITOR is a chat outside focus that failed or needs you. It shows dashed, in every state of the
//   dock, and leaves on its own once dealt with. Urgency can visit; it can't evict a pin.
// - The dock only SWITCHES (tap a chip, swipe the bar through recent chats). No long-press drag on it:
//   One UI's launcher owns long-press at the bottom edge, and the bar already owns the horizontal swipe.
// - Its sheet opens from the HANDLE above the bar, ~24dp off the screen edge, so swiping up never lands
//   on Android's own home gesture.
// - Pinning lives behind the sheet's "Edit pins" (round 13, 2026-10-09 — it replaced a ＋ on every row
//   and a swipe-left unpin). Undo rides on every change.
// - Full at three: a DONE pin steps out by itself (with Undo). The swap question appears only when all
//   three are still active, so pinning is one tap almost every time. Nothing running is ever evicted.
// - Everything counts TASKS, not sessions (lib/task-groups.ts): sessions sharing a worktree are one row.
// - Sorted by urgency, never recency: failed → needs you → running → new → idle. Nothing expands or
//   opens on its own; the sheet waits for the tap.
import ChatName from "@/components/ChatName";
import { projectLabel } from "@/lib/chat-title";
import { memo, useMemo, useRef, useState, type TouchEvent } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { groupOf, Ring, type Group, type InboxLive, type InboxSession } from "@/components/Inbox";
import { ProjectIcon } from "@/components/ProjectIcon";
import type { TaskProgress } from "@/lib/task-progress";
import { FOCUS_MAX } from "@/lib/use-focus";
import { byUrgency, groupTasks, type Task } from "@/lib/task-groups";

export type FocusLive = InboxLive & { progress?: TaskProgress };
type Ctx = {
  sessions: InboxSession[];
  live: Record<string, FocusLive>;
  seen: Record<string, number>;
  floor: number;
  icons: Record<string, string>;
  focus: string[];
};

const NEED_VERB: Record<string, string> = { question: "Asks", plan: "Plan to review", held: "Held", permission: "Wants" };

function useGroups({ sessions, live, seen, floor }: Ctx) {
  return useMemo(() => {
    const g: Record<string, Group> = {};
    for (const s of sessions) g[s.id] = groupOf(s, live[s.id], seen[s.id] || 0, floor);
    return g;
  }, [sessions, live, seen, floor]);
}

function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

/** "build · 2 of 4 · ~6m · 12s ago" — the step by NAME (a bare 3/7 is a counter, not progress), then an
 *  ETA that admits how old it is. Past 30s without a finished step the ETA widens to a range. */
function stepLine(p: TaskProgress): string {
  const parts = [p.now || "working", `${Math.min(p.done + 1, p.total)} of ${p.total}`];
  if (p.etaAt) {
    const m = Math.max(1, Math.round((p.etaAt - Date.now()) / 60000));
    const stale = p.lastDoneAt ? Date.now() - p.lastDoneAt > 30_000 : true;
    parts.push(stale ? `${m}–${Math.round(m * 1.5) + 1}m` : `~${m}m`);
  }
  if (p.lastDoneAt) parts.push(`${ago(p.lastDoneAt)} ago`);
  return parts.join(" · ");
}

/** Milestones, not a percentage: one segment per step, the one in flight half-lit. */
function Segments({ p }: { p: TaskProgress }) {
  const n = Math.min(p.total, 12);
  return (
    <span className="flex gap-[3px]">
      {Array.from({ length: n }).map((_, i) => (
        <span key={i} className="h-[4px] flex-1 rounded-full" style={{ background: i < p.done ? "#f0a868" : i === p.done ? "rgba(240,168,104,.45)" : "rgba(255,255,255,.08)" }} />
      ))}
    </span>
  );
}


/** Tasks (lib/task-groups.ts) with pinned-ness, from the same ctx the dock and sheet share. */
function useTasks(ctx: Ctx) {
  const groups = useGroups(ctx);
  return useMemo(() => {
    const tasks = groupTasks(ctx.sessions, groups);
    const pinned = (t: Task) => t.members.some((m) => ctx.focus.includes(m.id));
    const ofSession = new Map<string, Task>();
    for (const t of tasks) for (const m of t.members) ofSession.set(m.id, t);
    return { groups, tasks, pinned, ofSession };
  }, [ctx.sessions, ctx.focus, groups]);
}

// ── the dock ──────────────────────────────────────────────────────────────────────────────────────
export const FocusDock = memo(function FocusDock({ ctx, current, recent, hidden, onOpen, onSheet, onSwipe }: {
  ctx: Ctx;
  current: { id: string | null; title: string; project?: string };
  /** Fallback while nothing is pinned yet: recently visited chats, so a new user's dock isn't empty. */
  recent: string[];
  hidden?: boolean;
  onOpen: (id: string) => void;
  onSheet: () => void;
  onSwipe: (e: TouchEvent<HTMLDivElement>) => void;
}) {
  const { groups, tasks, pinned, ofSession } = useTasks(ctx);
  const curTask = current.id ? ofSession.get(current.id) : undefined;
  // Chips are TASKS (their most urgent session), so a pin keeps pointing at the task as it moves on to
  // a new session, and the task you're in never shows twice.
  const pinTasks = ctx.focus.length ? tasks.filter((t) => pinned(t)) : recent.map((id) => ofSession.get(id)).filter((t): t is Task => !!t);
  const pins = [...new Set(pinTasks)].filter((t) => t !== curTask).sort(byUrgency).map((t) => t.rep.id);
  // One visitor: the most urgent task OUTSIDE focus — a failure first, then one that needs you.
  const visitor = tasks.filter((t) => t !== curTask && !pinned(t) && (t.g === "failed" || t.g === "need")).sort(byUrgency)[0]?.rep;
  const byId = useMemo(() => new Map(ctx.sessions.map((s) => [s.id, s])), [ctx.sessions]);
  const shown = pins.slice(0, visitor ? 1 : 2), more = pins.length - shown.length;
  const curG = curTask?.g ?? (current.id ? groups[current.id] : undefined);
  // Handle swipe-up opens the sheet; the bar's horizontal swipe keeps stepping through recent chats.
  const y0 = useRef<number | null>(null);
  const chip = (id: string, g: Group, dashed?: boolean) => {
    const s = byId.get(id)!;
    return (
      <button key={id} onClick={() => onOpen(id)} aria-label={s.title}
        className={`relative flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-2 ${dashed ? "border-dashed" : ""} ${g === "failed" && dashed ? "border-[#ef7c7c]/70" : "border-white/10"} active:bg-white/10`}>
        <span className="relative"><ProjectIcon name={s.project} icon={ctx.icons[s.project]} size={20} /><Ring g={g} /></span>
      </button>
    );
  };
  return (
    <div className={`border-t border-white/10 bg-neutral-950/90 pb-[max(0.375rem,env(safe-area-inset-bottom))] ${hidden ? "hidden" : ""}`}>
      <button aria-label="All chats and progress" onClick={onSheet}
        onTouchStart={(e) => { y0.current = e.touches[0].clientY; }}
        onTouchEnd={(e) => { if (y0.current != null && y0.current - e.changedTouches[0].clientY > 24) onSheet(); y0.current = null; }}
        className="flex w-full justify-center pb-1 pt-1.5"><span className="h-1 w-9 rounded-full bg-white/20" /></button>
      <div className="flex items-center gap-1.5 px-1.5" onTouchStart={onSwipe} onTouchEnd={onSwipe}>
        {/* "Where am I", answered in the one place the folded N5 looks (audit 2026-10-08: the only identity
            was this chip cut to "Ecvision: Fix pinn…", with no state). Two lines — project · state over
            the title — and wider. Keyed by chat so a swipe that lands somewhere new visibly slides in;
            the ‹ › are the swipe's only affordance. */}
        <button key={current.id || "new"} onClick={onSheet} aria-label={`${current.title} — all chats`}
          className="flex h-11 min-w-0 max-w-[62%] shrink animate-[slidein_.25s_ease] items-center gap-1.5 rounded-xl border border-[var(--sakura)]/50 bg-[var(--sakura)]/10 pl-1.5 pr-3 text-left">
          <span aria-hidden className="text-[12px] text-neutral-600">‹</span>
          <span className="min-w-0 leading-tight">
            <span className="flex items-center gap-1 text-[11px] text-neutral-400">
              {current.project && <span className="truncate">{projectLabel(current.project)}</span>}
              {curG && <span className={`shrink-0 ${STATE_TINT[curG]}`}>· {STATE_WORD[curG]}</span>}
            </span>
            <span className="block truncate text-[14px] font-medium">{current.title}</span>
          </span>
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {visitor && chip(visitor.id, groups[visitor.id], true)}
          {shown.map((id) => chip(id, groups[id]))}
          {more > 0 && <button onClick={onSheet} className="h-11 min-w-11 shrink-0 rounded-xl border border-white/10 px-2.5 text-[13px] tabular-nums text-neutral-400">+{more}</button>}
        </div>
        <button onClick={onSheet} aria-label="All chats" className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 px-3 text-[15px] text-neutral-300">☰</button>
      </div>
    </div>
  );
});

const STATE_WORD: Record<Group, string> = { failed: "failed", need: "needs you", running: "working", new: "new reply", idle: "done" };
const STATE_TINT: Record<Group, string> = { failed: "text-[#ef7c7c]", need: "text-[#4ade80]", running: "text-[#f0a868]", new: "text-neutral-200", idle: "text-neutral-500" };
/** A task stays in Active this long after it last moved; past that, idle tasks fold into Older. */
const ACTIVE_MS = 6 * 3600_000;

// ── the sheet ─────────────────────────────────────────────────────────────────────────────────────
// Round 13 (2026-10-09, from Thomas's interview + a research pass over Slack Activity, Telegram
// folders, GitHub's Copilot session list and Gmail threading): the sheet is for SWITCHING, not for
// managing a list. So:
// - One row per task (lib/task-groups.ts). "3 sessions" on the row; the chevron lists the older ones.
// - PINNED (≤3, by hand) → ACTIVE (anything waiting, failed, working, unread, or touched in the last
//   6h — sorts itself by urgency) → OLDER, folded to one line. 26 sessions read as ~6 rows here.
// - Pinning moved behind "Edit pins": a ＋ on all 21 rows outside focus was the loudest thing on the
//   sheet and the least used. In edit mode every row shows a visible Pin/Unpin button (no swipe-only
//   action — swipes go undiscovered unless paired with a button).
export function FocusSheet({ side, ctx, currentId, pin, unpin, onOpen, onNew, onClose, onInbox, onDismiss }: {
  /** N5 unfolded: a drawer from the left over the reading column, instead of a sheet from the bottom. */
  side?: boolean;
  ctx: Ctx;
  currentId: string | null;
  pin: (id: string, swapOut?: string) => Promise<"ok" | "full" | "error">;
  unpin: (id: string) => Promise<void>;
  onOpen: (id: string) => void;
  onNew: () => void;
  /** Close the chat on screen (the old sheet's job, kept here so the phone still has a way to do it). */
  onClose?: () => void;
  onInbox: () => void;
  onDismiss: () => void;
}) {
  const { tasks, pinned, ofSession } = useTasks(ctx);
  const [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null);
  const [swapFor, setSwapFor] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [older, setOlder] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = (text: string, undo: () => void) => {
    setToast({ text, undo });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };
  const now = Date.now();
  const pins = tasks.filter(pinned).sort(byUrgency);
  const rest = tasks.filter((t) => !pinned(t)).sort(byUrgency);
  const active = rest.filter((t) => t.g !== "idle" || now - t.last < ACTIVE_MS);
  const old = rest.filter((t) => !active.includes(t));
  const count = (g: Group) => tasks.filter((t) => t.g === g).length;
  const current = currentId ? ofSession.get(currentId) : undefined;

  const doPin = async (t: Task, swapOut?: Task) => {
    // Full: a DONE pin (finished, nothing waiting) steps out on its own; ask only if none is done.
    const done = !swapOut && pins.length >= FOCUS_MAX ? pins.find((p) => p.g === "idle" || p.g === "new") : undefined;
    const out = swapOut || done;
    // The server stores up to 8 session ids, so the three-TASK limit is enforced here.
    if (!out && pins.length >= FOCUS_MAX) { setSwapFor(t.key); return; }
    for (const m of out?.members ?? []) if (ctx.focus.includes(m.id) && m.id !== out!.rep.id) await unpin(m.id);
    const outId = out ? (out.members.find((m) => ctx.focus.includes(m.id))?.id ?? out.rep.id) : undefined;
    const r = await pin(t.rep.id, outId);
    if (r === "full") { setSwapFor(t.key); return; }
    setSwapFor(null);
    if (r === "ok" && out) say(`Pinned ${t.rep.title} · ${out.rep.title} moved out`, () => { pin(out.rep.id, t.rep.id); });
  };
  const doUnpin = (t: Task) => {
    for (const m of t.members) if (ctx.focus.includes(m.id)) unpin(m.id);
    say(`${t.rep.title} unpinned`, () => { pin(t.rep.id); });
  };
  const row = (t: Task) => (
    <div key={t.key}>
      <TaskRow t={t} l={ctx.live} icon={ctx.icons[t.rep.project]} on={t === current} currentId={currentId} onOpen={onOpen}
        action={edit ? (pinned(t) ? { label: "Unpin", run: () => doUnpin(t) } : { label: "Pin", run: () => doPin(t) }) : undefined} />
      {swapFor === t.key && (
        <div className="mx-2 mb-2 rounded-xl bg-white/[0.05] p-3">
          <p className="text-[13px] font-semibold">{FOCUS_MAX} pins already. Swap out:</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {pins.map((p) => <button key={p.key} onClick={() => doPin(t, p)} className="h-11 max-w-[60%] truncate rounded-lg border border-white/10 px-3 text-[13px] active:bg-white/10">{p.rep.title}</button>)}
            <button onClick={() => setSwapFor(null)} className="h-11 px-3 text-[13px] text-neutral-500">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
  const head = (text: string, tint = "text-neutral-500") => <p className={`px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.09em] ${tint}`}>{text}</p>;

  return (
    <div className={`fixed inset-0 z-[70] flex ${side ? "flex-row" : "flex-col justify-end"}`} role="dialog" aria-label="All chats">
      <div className="absolute inset-0 bg-black/50" onClick={onDismiss} />
      <div className={`relative flex flex-col bg-neutral-900 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl ${side ? "h-full w-[380px] max-w-[85vw] border-r border-white/10 pt-3" : "max-h-[88dvh] rounded-t-2xl border-t border-white/10"}`}>
        {!side && <button onClick={onDismiss} aria-label="Close" className="flex w-full justify-center py-2.5"><span className="h-1 w-10 rounded-full bg-white/20" /></button>}
        <div className="flex items-center gap-2 px-5 pb-1">
          <p className="min-w-0 flex-1 text-[13px] text-neutral-400">
            {count("failed") > 0 && <span className="text-[#ef7c7c]">{count("failed")} failed · </span>}
            {count("need") > 0 ? <span className="font-semibold text-[#4ade80]">{count("need")} need you</span> : <span>Nothing waiting</span>}
            {count("running") > 0 && <> · {count("running")} working</>}
          </p>
          <button onClick={() => { setEdit((v) => !v); setSwapFor(null); }}
            className={`h-11 shrink-0 rounded-xl px-3 text-[13px] ${edit ? "bg-[var(--sakura)] font-semibold text-white" : "border border-white/10 text-neutral-300"}`}>{edit ? "Done" : "Edit pins"}</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2">
          {(pins.length > 0 || edit) && head(pins.length > FOCUS_MAX ? `Pinned · ${pins.length} · limit ${FOCUS_MAX}` : `Pinned · ${pins.length} of ${FOCUS_MAX}`, "text-[var(--sakura)]")}
          {edit && pins.length === 0 && <p className="px-3 pb-2 text-[13px] text-neutral-500">Tap Pin on up to {FOCUS_MAX} tasks to keep them on top and in your dock.</p>}
          {pins.map(row)}
          {head(`Active · ${active.length}`)}
          {active.length === 0 && <p className="px-3 pb-2 text-[13px] text-neutral-500">Nothing moved in the last 6 hours.</p>}
          {active.map(row)}
          {old.length > 0 && (older ? <>{head(`Older · ${old.length}`)}{old.slice(0, older).map(row)}</> : null)}
          {old.length > older && (
            <button onClick={() => setOlder((n) => n + 15)} className="flex h-11 w-full items-center px-4 text-left text-[13px] text-neutral-500 active:bg-white/5">
              {older ? `Show ${Math.min(15, old.length - older)} more` : `Older · ${old.length} task${old.length === 1 ? "" : "s"}`} ›
            </button>
          )}
        </div>
        {toast && (
          <div className="mx-3 mb-2 mt-1 flex items-center gap-3 rounded-xl bg-neutral-800 px-3 py-2.5 text-[13px] shadow-lg">
            <span className="min-w-0 flex-1 truncate">{toast.text}</span>
            <button onClick={() => { toast.undo(); setToast(null); }} className="h-11 font-semibold text-[var(--sakura)]">Undo</button>
          </div>
        )}
        <div className="flex gap-2 border-t border-white/10 px-3 pt-2">
          <button onClick={onInbox} className="h-11 flex-1 rounded-xl border border-white/10 text-[14px] text-neutral-300 active:bg-white/10">Inbox</button>
          {onClose && <button onClick={onClose} className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/10 text-[14px] text-neutral-300 active:bg-white/10"><X className="h-4 w-4" />Close chat</button>}
          <button onClick={onNew} className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-[var(--sakura)]/40 text-[14px] text-[var(--sakura)] active:bg-[var(--sakura)]/10"><Plus className="h-4 w-4" />New chat</button>
        </div>
      </div>
    </div>
  );
}

/** One task: state ring, title, what it needs or is doing; "N sessions" with a chevron that lists the
 *  older ones, each openable. */
function TaskRow({ t, l: live, icon, on, currentId, onOpen, action }: {
  t: Task; l: Record<string, FocusLive>; icon?: string; on: boolean; currentId: string | null;
  onOpen: (id: string) => void; action?: { label: string; run: () => void };
}) {
  const [open, setOpen] = useState(false);
  const s = t.rep, g = t.g, l = live[s.id];
  const line = g === "need" ? `${NEED_VERB[l?.need?.kind || ""] || "Needs you"}: ${l?.need?.summary || ""}`
    : g === "failed" ? `Failed: ${l?.ended?.error || "the turn ended with an error"}`
    : g === "running" ? (l?.progress ? stepLine(l.progress) : !l?.busy && l?.bg ? `${l.bg} running in background` : `${l?.label || "working"}…`)
    : (l?.ended?.text || s.tail || "").replace(/\s+/g, " ");
  const n = t.members.length;
  return (
    <div className={`rounded-xl ${on ? "bg-[#2b1e23]" : ""}`}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button onClick={() => onOpen(s.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className="relative shrink-0"><ProjectIcon name={s.project} icon={icon} /><Ring g={g} /></span>
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-[15px] ${g === "idle" ? "text-neutral-300" : "font-medium text-neutral-50"}`}><ChatName project={s.project} title={s.title} /></span>
            <span className={`block truncate text-[13px] ${g === "failed" ? "text-[#ef7c7c]" : g === "need" ? "text-[#4ade80]" : "text-neutral-500"} ${g === "running" && !l?.progress ? "italic" : ""}`}>{line}</span>
            {g === "running" && l?.progress && <span className="mt-1.5 block"><Segments p={l.progress} /></span>}
          </span>
        </button>
        {action ? (
          <button onClick={action.run} className={`h-11 shrink-0 rounded-xl px-3 text-[13px] font-medium ${action.label === "Pin" ? "border border-[var(--sakura)]/50 text-[var(--sakura)]" : "border border-white/15 text-neutral-300"}`}>{action.label}</button>
        ) : n > 1 && (
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`${n} chats in this task`}
            className="flex h-11 shrink-0 items-center gap-1 rounded-xl px-2 text-[12px] tabular-nums text-neutral-500 active:bg-white/10">
            {n} chats<ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>
      {open && !action && (
        <div className="mb-1.5 ml-[52px] mr-3 border-l border-white/10">
          {t.members.map((m) => (
            <button key={m.id} onClick={() => onOpen(m.id)}
              className={`flex min-h-[44px] w-full items-center gap-2 pl-3 pr-1 text-left text-[13px] active:bg-white/5 ${m.id === currentId ? "text-[var(--sakura)]" : "text-neutral-400"}`}>
              <span className="min-w-0 flex-1 truncate">{m.title}</span>
              <span className="shrink-0 tabular-nums text-neutral-600">{ago(m.lastActivity)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
