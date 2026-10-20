"use client";
// The phone's home: every chat across every topic, grouped by what it needs from you (§23).
//
// The bento board answers "which project?"; on a phone the question is "what needs me?", and the
// Project → chat hierarchy cost two or three taps to reach any one chat — four to hop between two
// projects. Here every chat is one tap away, whatever topic it lives in.
//
// Design (agreed in a three-designer review, docs/knowledge/23-mobile.md):
// - Groups, in order: NEEDS YOU (question / plan / held step / permission) → FAILED → NEW (finished,
//   unread) → RUNNING → IDLE. Failures get their own group so NEEDS YOU keeps meaning "a human must
//   decide now"; mixed in, it would be skimmed.
// - Status by shape and motion, never colour alone: a STILL ring is your turn, a MOVING one is work.
// - Rows change group only when their state changes, and never re-sort under a finger: a list that
//   reorders while you reach for it lands the tap on the wrong chat.
// - Nothing approves from here. A row says what's needed; the decision is made in the chat, with
//   the transcript beside it.
import ChatName from "@/components/ChatName";
import { memo, useMemo, useRef, useState } from "react";
import { ProjectIcon } from "@/components/ProjectIcon";
import { groupTasks, RANK } from "@/lib/task-groups";
import { projectKey, useProjectFilter } from "@/lib/project-filter";
import { useSetting } from "@/lib/use-settings";

export type InboxSession = { id: string; project: string; title: string; tail: string; lastActivity: number; lastRole: string;
  /** Task key (lib/task-groups.ts): sessions sharing a worktree are one task, one row. */
  task?: string;
  /** Started by a Today hand-off (lib/today-origin.ts). */
  today?: boolean };
export type InboxLive = {
  phase: string; label: string; busy: boolean; bg?: number; turnStartedAt?: number | null;
  need?: { kind: string; summary: string; expiresAt?: number }; needs?: number;
  ended?: { at: number; ok: boolean; text?: string; error?: string };
};
export type Group = "need" | "failed" | "new" | "running" | "idle";
const GROUPS: { key: Group; label: string }[] = [
  { key: "need", label: "Needs you" }, { key: "failed", label: "Failed" }, { key: "new", label: "New" },
  { key: "running", label: "Running" }, { key: "idle", label: "Idle" },
];
/** How chats started from the Today page sit in the list. Fold is the default: half the board can be
 *  Today hand-offs (29 of 59 on 2026-10-20), and listed one by one they buried everything else. */
export type TodayMode = "fold" | "show" | "hide" | "only";
const TODAY_MODES: { key: TodayMode; label: string }[] = [
  { key: "fold", label: "Fold" }, { key: "show", label: "Show" }, { key: "hide", label: "Hide" }, { key: "only", label: "Only" },
];
const NEED_VERB: Record<string, string> = { question: "Asks", plan: "Plan to review", held: "Held", permission: "Wants" };

function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function groupOf(s: InboxSession, l: InboxLive | undefined, seenAt: number, floor: number): Group {
  if (l?.need) return "need";
  if (l?.busy) return "running";
  const endedAt = l?.ended?.at ?? (s.lastRole === "assistant" ? s.lastActivity : 0);
  const unread = endedAt > Math.max(seenAt, floor);
  if (l?.ended && !l.ended.ok && unread) return "failed";
  if (unread) return "new";
  // The turn ended but agents or shells it backgrounded are still out there — that is not idle
  // (audit 2026-10-08: the dock read "0 working" with three agents running). An unread reply still
  // ranks above it, since that is what there is to read right now.
  if (l?.bg) return "running";
  return "idle";
}

export const Inbox = memo(function Inbox({ sessions, live, seen, floor, icons, current, strip, onOpen, onMarkRead, head }: {
  sessions: InboxSession[];
  live: Record<string, InboxLive>;
  seen: Record<string, number>;
  floor: number;
  icons: Record<string, string>;
  /** The chat open beside the list (N5 unfolded), highlighted. */
  current?: string | null;
  /** Collapsed to an icon strip while the keyboard is up (N5 unfolded): the composer needs the width. */
  strip?: boolean;
  onOpen: (id: string) => void;
  onMarkRead: (id: string) => void;
  /** Rendered above the groups — the team inbox's row (§25). */
  head?: React.ReactNode;
}) {
  const [showIdle, setShowIdle] = useState(5);
  // The topic chips write the SHELL's project filter (§30), so the picker up top and these chips are
  // one control. But the inbox matches the topic exactly, where other pages match by prefix: there,
  // "ecvision" keeping "ecvisionContent" is sibling work worth seeing; here it put another topic's
  // twelve chats in the list you had just narrowed.
  const [pf, setPf] = useProjectFilter();
  const [todayMode, setTodayMode] = useSetting<TodayMode>("inboxToday", "fold");
  const [openFold, setOpenFold] = useState<Set<string>>(new Set());
  const inMode = (s: InboxSession) => todayMode === "hide" ? !s.today : todayMode === "only" ? !!s.today : true;
  const topics = useMemo(() => {
    const c = new Map<string, number>();
    for (const s of sessions) if (inMode(s)) c.set(s.project, (c.get(s.project) || 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [sessions, todayMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = useMemo(() => sessions.filter((s) => inMode(s) && (!pf || projectKey(s.project) === projectKey(pf))),
    [sessions, todayMode, pf]); // eslint-disable-line react-hooks/exhaustive-deps
  // Frozen while a finger is down: the poll keeps landing, but the order the user is aiming at
  // doesn't move until they let go.
  const [touching, setTouching] = useState(false);
  // One row per task (lib/task-groups.ts): a task's row is its most urgent session, so the group it
  // lands in is the task's state, and the older sessions of the same worktree stay out of the list.
  const { grouped, extra, folded } = useMemo(() => {
    const gs: Record<string, Group> = {};
    for (const s of visible) gs[s.id] = groupOf(s, live[s.id], seen[s.id] || 0, floor);
    const by: Record<Group, InboxSession[]> = { need: [], failed: [], new: [], running: [], idle: [] };
    const extra: Record<string, number> = {};
    // Folded Today chats: one row per topic. A Today chat that needs you or failed stays a row of its
    // own — folding a question away is how it goes unanswered.
    const folded = new Map<string, InboxSession[]>();
    for (const t of groupTasks(visible, gs)) {
      if (todayMode === "fold" && t.rep.today && t.g !== "need" && t.g !== "failed") {
        const a = folded.get(t.rep.project) || [];
        a.push(t.rep); folded.set(t.rep.project, a);
        continue;
      }
      by[t.g].push(t.rep); if (t.members.length > 1) extra[t.rep.id] = t.members.length;
    }
    for (const a of folded.values()) a.sort((x, y) => RANK[gs[x.id]] - RANK[gs[y.id]] || y.lastActivity - x.lastActivity);
    // Needs-you: soonest auto-deny first (a held step expires), then longest waiting.
    by.need.sort((a, b) => (live[a.id]?.need?.expiresAt ?? Infinity) - (live[b.id]?.need?.expiresAt ?? Infinity) || a.lastActivity - b.lastActivity);
    const endedAt = (s: InboxSession) => live[s.id]?.ended?.at ?? s.lastActivity;
    by.failed.sort((a, b) => endedAt(b) - endedAt(a));
    by.new.sort((a, b) => endedAt(b) - endedAt(a));
    by.running.sort((a, b) => (live[b.id]?.turnStartedAt ?? 0) - (live[a.id]?.turnStartedAt ?? 0));
    by.idle.sort((a, b) => b.lastActivity - a.lastActivity);
    return { grouped: by, extra, folded: [...folded].sort((a, b) => b[1][0].lastActivity - a[1][0].lastActivity) };
  }, [visible, live, seen, floor, todayMode]);
  const last = useRef({ grouped, folded });
  if (!touching) last.current = { grouped, folded };
  const g = last.current.grouped;
  const fold = last.current.folded;

  if (strip) {
    // Icons only, needs-you first, with the count — enough to see something changed and tap to it.
    const order = [...g.need, ...g.failed, ...g.new, ...g.running].slice(0, 9);
    return (
      <div className="flex h-full flex-col items-center gap-2 overflow-y-auto py-2">
        {g.need.length > 0 && <span className="rounded-full bg-[#4ade80]/20 px-2 text-[11px] font-semibold tabular-nums text-[#4ade80]">{g.need.length}</span>}
        {order.map((s) => (
          <button key={s.id} onClick={() => onOpen(s.id)} aria-label={s.title} className={`relative rounded-xl p-1 ${current === s.id ? "bg-white/10" : ""}`}>
            <ProjectIcon name={s.project} icon={icons[s.project]} />
            <Ring g={groupOf(s, live[s.id], seen[s.id] || 0, floor)} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2" onTouchStart={() => setTouching(true)} onTouchEnd={() => setTouching(false)} onTouchCancel={() => setTouching(false)}>
      {head}
      <Filters topics={topics} pf={pf} setPf={setPf} total={sessions.filter(inMode).length} todayMode={todayMode} setTodayMode={setTodayMode} />
      {GROUPS.map(({ key, label }) => {
        const rows = g[key];
        if (!rows.length) return null;
        const shown = key === "idle" ? rows.slice(0, showIdle) : rows;
        return (
          <section key={key}>
            <h3 className={`sticky top-0 z-10 bg-neutral-950/95 px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.09em] ${key === "need" ? "text-[#4ade80]" : key === "failed" ? "text-[#ef7c7c]" : "text-neutral-500"}`}>
              {label} · {rows.length}
            </h3>
            {shown.map((s) => <Row key={s.id} s={s} l={live[s.id]} group={key} icon={icons[s.project]} on={current === s.id} chats={extra[s.id]} onOpen={onOpen} onMarkRead={onMarkRead} />)}
            {key === "idle" && rows.length > showIdle && (
              <button onClick={() => setShowIdle((n) => n + 20)} className="w-full px-4 py-3 text-left text-[13px] text-neutral-500 active:bg-white/5">Show {Math.min(20, rows.length - showIdle)} more</button>
            )}
          </section>
        );
      })}
      {fold.length > 0 && (
        <section>
          <h3 className="sticky top-0 z-10 bg-neutral-950/95 px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.09em] text-neutral-500">
            From Today · {fold.reduce((n, [, a]) => n + a.length, 0)}
          </h3>
          {fold.map(([project, rows]) => {
            const open = openFold.has(project);
            const gs = rows.map((s) => groupOf(s, live[s.id], seen[s.id] || 0, floor));
            const running = gs.filter((x) => x === "running").length, fresh = gs.filter((x) => x === "new").length;
            return (
              <div key={project}>
                <button onClick={() => setOpenFold((p) => { const n = new Set(p); if (n.has(project)) n.delete(project); else n.add(project); return n; })}
                  aria-expanded={open}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/[0.06]">
                  <span className="relative shrink-0"><ProjectIcon name={project} icon={icons[project]} />{running > 0 && <Ring g="running" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-neutral-200">{project} <span className="text-neutral-500">· Today</span></span>
                    <span className="block truncate text-[13px] text-neutral-500">
                      {rows.length} {rows.length === 1 ? "chat" : "chats"}{running ? ` · ${running} running` : ""}{fresh ? ` · ${fresh} new` : ""}
                    </span>
                  </span>
                  <span className={`shrink-0 text-[18px] text-neutral-500 transition-transform ${open ? "rotate-90" : ""}`}>›</span>
                </button>
                {open && <div className="border-l border-white/10 ml-6">
                  {rows.map((s, i) => <Row key={s.id} s={s} l={live[s.id]} group={gs[i]} icon={icons[s.project]} on={current === s.id} onOpen={onOpen} onMarkRead={onMarkRead} />)}
                </div>}
              </div>
            );
          })}
        </section>
      )}
      {!visible.length && <p className="px-6 py-16 text-center text-sm text-neutral-500">{sessions.length ? "Nothing here with these filters." : "No chats in this window."}</p>}
    </div>
  );
});

/** Still ring = your turn; spinning arc = working; dot = unread; nothing = idle. Shape and motion carry
 *  it, so it reads at arm's length and for anyone who can't separate the hues. */
export function Ring({ g }: { g: Group }) {
  if (g === "idle") return null;
  if (g === "running") return <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#f0a868] border-t-transparent bg-neutral-950" />;
  const c = g === "need" ? "#4ade80" : g === "failed" ? "#ef7c7c" : "var(--sakura)";
  return <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 bg-neutral-950" style={{ borderColor: c, background: g === "new" ? c : undefined }} />;
}

const Row = memo(function Row({ s, l, group, icon, on, chats, onOpen, onMarkRead }: {
  s: InboxSession; l?: InboxLive; group: Group; icon?: string; on: boolean; chats?: number; onOpen: (id: string) => void; onMarkRead: (id: string) => void;
}) {
  // Line 2 is the decision, the activity or the result — never a tool dump.
  const detail = group === "need" ? `${NEED_VERB[l!.need!.kind] || "Needs you"}: ${l!.need!.summary}`
    : group === "running" ? `${l?.label || "working"}…`
    : group === "failed" ? `Failed: ${l?.ended?.error || "the turn ended with an error"}`
    : (l?.ended?.text || s.tail || "").replace(/\s+/g, " ");
  const when = group === "need" ? `waiting ${ago(s.lastActivity)}` : group === "running" && l?.turnStartedAt ? ago(l.turnStartedAt) : ago(l?.ended?.at ?? s.lastActivity);
  const bold = group === "new" || group === "need" || group === "failed";
  // Swipe right marks read — a reversible, low-stakes gesture. Never an approval (see the header).
  const x0 = useRef<number | null>(null);
  return (
    <button onClick={() => onOpen(s.id)}
      onTouchStart={(e) => { x0.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => { if (x0.current != null && e.changedTouches[0].clientX - x0.current > 80 && (group === "new" || group === "failed")) onMarkRead(s.id); x0.current = null; }}
      className={`flex w-full items-start gap-3 px-4 text-left active:bg-white/[0.06] ${group === "need" ? "py-3.5" : "py-2.5"} ${on ? "bg-white/[0.07]" : ""}`}>
      <span className="relative mt-0.5 shrink-0">
        <ProjectIcon name={s.project} icon={icon} />
        <Ring g={group} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-[15px] ${bold ? "font-semibold text-neutral-50" : "text-neutral-300"}`}><ChatName project={s.project} title={s.title} /></span>
          {chats && <span className="shrink-0 rounded-md bg-white/[0.06] px-1.5 text-[11px] tabular-nums text-neutral-400">{chats} chats</span>}
          <span className={`shrink-0 text-[12px] tabular-nums ${group === "need" ? "text-[#f0a868]" : "text-neutral-500"}`}>{when}</span>
        </span>
        <span className={`block text-[13px] leading-snug ${group === "need" ? "line-clamp-2 text-neutral-200" : "truncate text-neutral-500"}`}>
          {group === "running" ? <i>{detail}</i> : detail}
        </span>
      </span>
    </button>
  );
});

/** Topic chips (exact match, written to the shell's filter) and the Today switch. Thumb-sized: 34px. */
function Filters({ topics, pf, setPf, total, todayMode, setTodayMode }: {
  topics: [string, number][]; pf: string; setPf: (v: string) => void; total: number; todayMode: TodayMode; setTodayMode: (m: TodayMode) => void;
}) {
  const chip = (on: boolean) => `h-[34px] shrink-0 rounded-full px-3.5 text-[13px] tabular-nums ${on ? "bg-white/[0.14] text-neutral-50" : "bg-white/[0.04] text-neutral-400 active:bg-white/[0.08]"}`;
  const active = topics.find(([t]) => projectKey(t) === projectKey(pf))?.[0];
  return (
    <div className="flex flex-col gap-2 px-3 pb-1 pt-2">
      <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 [scrollbar-width:none]">
        <button className={chip(!pf)} onClick={() => setPf("")}>All · {total}</button>
        {/* A filter set elsewhere (the shell picker) that matches no topic here still shows, so it can be cleared. */}
        {pf && !active && <button className={chip(true)} onClick={() => setPf("")}>{pf} · 0 ✕</button>}
        {topics.map(([t, n]) => <button key={t} className={chip(t === active)} onClick={() => setPf(t === active ? "" : t)}>{t} · {n}</button>)}
      </div>
      <div className="flex items-center gap-1.5 text-[12px] text-neutral-500">
        <span className="pl-1 pr-1">Today chats</span>
        {TODAY_MODES.map(({ key, label }) => <button key={key} className={chip(todayMode === key)} onClick={() => setTodayMode(key)}>{label}</button>)}
      </div>
    </div>
  );
}
