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
// - In the sheet, pinning is a visible ＋ (safe) and unpinning is a swipe left (destructive, so never a
//   resting tap target a scroll flick can hit). Undo rides on REMOVE, the risky direction.
// - Full at five: a DONE pin steps out by itself (with Undo). The swap question appears only when all
//   five are still active, so pinning is one tap almost every time. Nothing running is ever evicted.
// - Sorted by urgency, never recency: failed → needs you → running → new → idle. Nothing expands or
//   opens on its own; the sheet waits for the tap.
import ChatName from "@/components/ChatName";
import { memo, useMemo, useRef, useState, type TouchEvent } from "react";
import { Plus, X } from "lucide-react";
import { groupOf, Ring, type Group, type InboxLive, type InboxSession } from "@/components/Inbox";
import { ProjectIcon } from "@/components/ProjectIcon";
import type { TaskProgress } from "@/lib/task-progress";
import { FOCUS_MAX } from "@/lib/use-focus";

export type FocusLive = InboxLive & { progress?: TaskProgress };
type Ctx = {
  sessions: InboxSession[];
  live: Record<string, FocusLive>;
  seen: Record<string, number>;
  floor: number;
  icons: Record<string, string>;
  focus: string[];
};

const RANK: Record<Group, number> = { failed: 0, need: 1, running: 2, new: 3, idle: 4 };
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
  const groups = useGroups(ctx);
  const byId = useMemo(() => new Map(ctx.sessions.map((s) => [s.id, s])), [ctx.sessions]);
  const pins = (ctx.focus.length ? ctx.focus : recent).filter((id) => id !== current.id && byId.has(id));
  // One visitor: the most urgent chat OUTSIDE focus — a failure first, then one that needs you.
  const visitor = ctx.sessions
    .filter((s) => s.id !== current.id && !ctx.focus.includes(s.id) && (groups[s.id] === "failed" || groups[s.id] === "need"))
    .sort((a, b) => RANK[groups[a.id]] - RANK[groups[b.id]] || b.lastActivity - a.lastActivity)[0];
  const shown = pins.slice(0, 2), more = pins.length - shown.length;
  // Handle swipe-up opens the sheet; the bar's horizontal swipe keeps stepping through recent chats.
  const y0 = useRef<number | null>(null);
  const chip = (id: string, g: Group, dashed?: boolean) => {
    const s = byId.get(id)!;
    return (
      <button key={id} onClick={() => onOpen(id)} aria-label={s.title}
        className={`relative flex h-10 shrink-0 items-center gap-1.5 rounded-xl border px-2 ${dashed ? "border-dashed" : ""} ${g === "failed" && dashed ? "border-[#ef7c7c]/70" : "border-white/10"} active:bg-white/10`}>
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
        <button onClick={onSheet} className="flex h-10 min-w-0 max-w-[45%] shrink items-center gap-2 rounded-xl border border-[var(--sakura)]/50 bg-[var(--sakura)]/10 px-3 text-left">
          <span className="min-w-0 truncate text-[14px] font-medium">{current.project ? <ChatName project={current.project} title={current.title} /> : current.title}</span>
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {visitor && chip(visitor.id, groups[visitor.id], true)}
          {shown.map((id) => chip(id, groups[id]))}
          {more > 0 && <button onClick={onSheet} className="h-10 shrink-0 rounded-xl border border-white/10 px-2.5 text-[13px] tabular-nums text-neutral-400">+{more}</button>}
        </div>
        <button onClick={onSheet} aria-label="All chats" className="flex h-10 shrink-0 items-center rounded-xl border border-white/10 px-3 text-[15px] text-neutral-300">☰</button>
      </div>
    </div>
  );
});

// ── the sheet ─────────────────────────────────────────────────────────────────────────────────────
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
  const groups = useGroups(ctx);
  const byId = useMemo(() => new Map(ctx.sessions.map((s) => [s.id, s])), [ctx.sessions]);
  const [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null);
  const [swapFor, setSwapFor] = useState<string | null>(null);
  const [more, setMore] = useState(12);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = (text: string, undo: () => void) => {
    setToast({ text, undo });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };
  const urgency = (a: InboxSession, b: InboxSession) => RANK[groups[a.id]] - RANK[groups[b.id]] || b.lastActivity - a.lastActivity;
  const inFocus = ctx.focus.map((id) => byId.get(id)).filter((s): s is InboxSession => !!s).sort(urgency);
  const outside = ctx.sessions.filter((s) => !ctx.focus.includes(s.id)).sort(urgency);
  const count = (g: Group) => ctx.sessions.filter((s) => groups[s.id] === g).length;
  const titleOf = (id: string) => byId.get(id)?.title || "chat";

  const doPin = async (id: string, swapOut?: string) => {
    // Full: a DONE pin (finished, nothing waiting) steps out on its own; ask only if none is done.
    const done = !swapOut && ctx.focus.length >= FOCUS_MAX ? ctx.focus.find((f) => groups[f] === "idle" || groups[f] === "new") : undefined;
    const out = swapOut || done;
    const r = await pin(id, out);
    if (r === "full") { setSwapFor(id); return; }
    setSwapFor(null);
    if (r === "ok" && out) say(`Pinned ${titleOf(id)} · ${titleOf(out)} moved out`, () => { pin(out, id); });
  };
  const doUnpin = (id: string) => {
    unpin(id);
    say(`${titleOf(id)} unpinned, still in the list`, () => { pin(id); });
  };

  return (
    <div className={`fixed inset-0 z-[70] flex ${side ? "flex-row" : "flex-col justify-end"}`} role="dialog" aria-label="All chats">
      <div className="absolute inset-0 bg-black/50" onClick={onDismiss} />
      <div className={`relative flex flex-col bg-neutral-900 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl ${side ? "h-full w-[380px] max-w-[85vw] border-r border-white/10 pt-3" : "max-h-[88dvh] rounded-t-2xl border-t border-white/10"}`}>
        {!side && <button onClick={onDismiss} aria-label="Close" className="flex w-full justify-center py-2.5"><span className="h-1 w-10 rounded-full bg-white/20" /></button>}
        <p className="px-5 pb-2 text-[12px] text-neutral-500">
          {count("failed") > 0 && <span className="text-[#ef7c7c]">✕ {count("failed")} failed · </span>}
          <span className="text-[#4ade80]">◯ {count("need")} need you</span> · ◌ {count("running")} working
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2">
          <p className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--sakura)]">In focus · {inFocus.length} of {FOCUS_MAX}</p>
          {inFocus.length === 0 && <p className="px-3 pb-2 text-[13px] text-neutral-500">Tap ＋ on a chat below to keep it in your dock.</p>}
          {inFocus.map((s) => <Row key={s.id} s={s} l={ctx.live[s.id]} g={groups[s.id]} icon={ctx.icons[s.project]} on={s.id === currentId} onOpen={onOpen} onUnpin={doUnpin} />)}
          <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.09em] text-neutral-500">Outside focus · {outside.length}</p>
          {outside.slice(0, more).map((s) => (
            <div key={s.id}>
              <Row s={s} l={ctx.live[s.id]} g={groups[s.id]} icon={ctx.icons[s.project]} on={s.id === currentId} onOpen={onOpen} onPin={doPin} />
              {swapFor === s.id && (
                <div className="mx-2 mb-2 rounded-xl bg-white/[0.05] p-3">
                  <p className="text-[13px] font-semibold">Dock is full ({FOCUS_MAX}). Swap out:</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {inFocus.map((f) => <button key={f.id} onClick={() => doPin(s.id, f.id)} className="h-9 max-w-[60%] truncate rounded-lg border border-white/10 px-3 text-[13px] active:bg-white/10">{f.title}</button>)}
                    <button onClick={() => setSwapFor(null)} className="h-9 px-3 text-[13px] text-neutral-500">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {outside.length > more && <button onClick={() => setMore((n) => n + 20)} className="w-full px-4 py-3 text-left text-[13px] text-neutral-500">Show {Math.min(20, outside.length - more)} more</button>}
        </div>
        {toast && (
          <div className="mx-3 mb-2 mt-1 flex items-center gap-3 rounded-xl bg-neutral-800 px-3 py-2.5 text-[13px] shadow-lg">
            <span className="min-w-0 flex-1 truncate">{toast.text}</span>
            <button onClick={() => { toast.undo(); setToast(null); }} className="font-semibold text-[var(--sakura)]">Undo</button>
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

/** One chat: state ring, title, what it needs or what it's doing (the step by name, with segments). In
 *  focus, swipe left reveals Unpin; outside, a visible ＋ pins it. */
function Row({ s, l, g, icon, on, onOpen, onPin, onUnpin }: {
  s: InboxSession; l?: FocusLive; g: Group; icon?: string; on: boolean;
  onOpen: (id: string) => void; onPin?: (id: string) => void; onUnpin?: (id: string) => void;
}) {
  const [dx, setDx] = useState(0);
  const x0 = useRef<{ x: number; y: number } | null>(null);
  const REVEAL = 92;
  const line = g === "need" ? `${NEED_VERB[l?.need?.kind || ""] || "Needs you"}: ${l?.need?.summary || ""}`
    : g === "failed" ? `Failed: ${l?.ended?.error || "the turn ended with an error"}`
    : g === "running" ? (l?.progress ? stepLine(l.progress) : `${l?.label || "working"}…`)
    : (l?.ended?.text || s.tail || "").replace(/\s+/g, " ");
  const row = (
    <div className={`relative z-10 flex items-center gap-3 rounded-xl px-3 py-2.5 ${on ? "bg-[#2b1e23]" : "bg-neutral-900"}`}
      style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: x0.current ? "none" : "transform .18s ease" }}
      onTouchStart={onUnpin ? (e) => { x0.current = { x: e.touches[0].clientX - dx, y: e.touches[0].clientY }; } : undefined}
      onTouchMove={onUnpin ? (e) => {
        if (!x0.current) return;
        const mx = e.touches[0].clientX - x0.current.x, my = e.touches[0].clientY - x0.current.y;
        if (Math.abs(my) > Math.abs(mx) && dx === 0) { x0.current = null; return; } // a scroll, not a swipe
        setDx(Math.max(-REVEAL, Math.min(0, mx)));
      } : undefined}
      onTouchEnd={onUnpin ? () => { setDx((d) => (d < -REVEAL / 2 ? -REVEAL : 0)); x0.current = null; } : undefined}>
      <button onClick={() => (dx ? setDx(0) : onOpen(s.id))} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="relative shrink-0"><ProjectIcon name={s.project} icon={icon} /><Ring g={g} /></span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[15px] ${g === "idle" ? "text-neutral-300" : "font-medium text-neutral-50"}`}><ChatName project={s.project} title={s.title} /></span>
          <span className={`block truncate text-[13px] ${g === "failed" ? "text-[#ef7c7c]" : g === "need" ? "text-[#4ade80]" : "text-neutral-500"} ${g === "running" && !l?.progress ? "italic" : ""}`}>{line}</span>
          {g === "running" && l?.progress && <span className="mt-1.5 block"><Segments p={l.progress} /></span>}
        </span>
      </button>
      {onPin && <button onClick={() => onPin(s.id)} aria-label="Pin to focus" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-white/15 text-neutral-400 active:bg-white/10"><Plus className="h-4 w-4" /></button>}
    </div>
  );
  if (!onUnpin) return row;
  return (
    <div className="relative overflow-hidden rounded-xl">
      <button onClick={() => { setDx(0); onUnpin(s.id); }} className="absolute inset-y-0 right-0 flex w-[92px] items-center justify-center bg-[var(--sakura)]/25 text-[13px] font-semibold text-[var(--sakura)]">Unpin</button>
      {row}
    </div>
  );
}
