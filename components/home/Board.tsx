"use client";
// One project's tasks as a board (§37): the step past the expanded tile, "so that I can focus when I need
// on a project" (Thomas, 2026-10-28). It takes the bento area — the chat panel still opens beside it — and
// the other projects stay one tap away in the switcher, so focusing never strands him.
//
// Columns follow the work, not a hand-kept status: Working / Needs you / Paused are read from the chats,
// so a card moves on its own when a reply lands. Only the two ends are his to move — To do (written down,
// not started) and Done. Dragging into a middle column says so instead of pretending to do something.
import { useEffect, useMemo, useRef, useState } from "react";
import { startAsk } from "@/lib/ask";
import { useSetting } from "@/lib/use-settings";
import { ensureDod, threadPost, useThreads, type ThreadView } from "@/lib/use-threads";
import type { AgentMode } from "@/lib/use-agent";
import { DodBar, TaskCard, TINT } from "./TaskCard";
import { StartingCard, useStartingCards } from "./StartingCard";

// Lanes by WHO holds the next move (pitch waiting-chain V1, picked 2026-10-29), read from the server's
// `wait.holder` (lib/threads.ts). The columns used to be the chat's state, so a task that was merged and
// live, one stuck on another chat's unsaved file and one that needed his pick all read "Needs you" and he
// had to open five chats to tell them apart. "Another task" shows only when something is in it.
type Col = "todo" | "working" | "waiting" | "blocked" | "paused" | "done";
const COLS: { id: Col; label: string; tint: string; hint: string }[] = [
  { id: "todo", label: "To do", tint: "rgba(255,255,255,0.35)", hint: "Written down, not started" },
  { id: "waiting", label: "You", tint: TINT.waiting, hint: "Your move: a reply, a pick, a go" },
  { id: "working", label: "Running", tint: TINT.working, hint: "A chat or its agents are working" },
  { id: "blocked", label: "Another task", tint: TINT.blocked, hint: "Stuck on something another chat left behind" },
  { id: "paused", label: "Paused", tint: "rgba(255,255,255,0.35)", hint: "Quiet, not finished" },
  { id: "done", label: "Done", tint: "#4ade80", hint: "Closing on their own, or moved here with ✓ Done" },
];
const allMet = (t: ThreadView) => !!t.dod?.length && t.dod.every((d) => d.done);
function colOf(t: ThreadView): Col {
  if (t.archived) return "done";
  if (t.state === "queued") return "todo";
  switch (t.wait?.holder) {
    case "you": return "waiting";
    case "machine": return "working";
    case "task": return "blocked";
    case "done": return "done";
    default: return t.state === "working" ? "working" : t.state === "waiting" ? "waiting" : "paused";
  }
}
const btn = "shrink-0 rounded-lg border border-white/12 px-2.5 py-1 text-[12px] text-neutral-200 transition-colors hover:border-white/30 pointer-coarse:py-2";
const mini = "rounded-md border border-white/12 px-2 py-0.5 text-[11px] text-neutral-300 transition-colors hover:border-white/30 hover:text-neutral-100 pointer-coarse:py-1.5";

// Below this width the five columns can't all show, so the board becomes one vertical list grouped in
// urgency order. Measured 2026-10-28 with a chat open at 1440px: the board column was 442px against
// 1048px of columns, so only To do and Working showed — the two usually empty — and using it meant
// dragging the divider and shrinking the chat ("don't make me reduce chat area"). Chosen by the board's
// own width, never a setting: the same board is 1185px alone and 442px beside a chat.
const STACK_BELOW = 1060;
const STACK_ORDER: Col[] = ["waiting", "working", "blocked", "todo", "paused", "done"];

export function Board({ project, cwd, onSwitch, onClose, onAllChats, openSids = [], focusSid }: {
  project: string; cwd: string; onSwitch: (project: string) => void; onClose: () => void; onAllChats: () => void;
  /** Sessions open in the chat panel: their task is ringed. `focusSid`'s task is scrolled into view. */
  openSids?: string[]; focusSid?: string | null;
}) {
  const d = useThreads();
  const [perm] = useSetting<Exclude<AgentMode, "plan">>("permMode", "bypassPermissions");
  const [model] = useSetting<string | null>("chatModel", null);
  const [draft, setDraft] = useState("");
  const [over, setOver] = useState<Col | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [starting, setStarting] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  const [showDone, setShowDone] = useState(() => { try { return localStorage.getItem("minami.boardDone") === "1"; } catch { return false; } });
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const stacked = width < STACK_BELOW;
  // A task being started holds the top of Working with a dashed card until its real card exists (§37).
  const pending = useStartingCards(project, [...(d?.threads ?? []), ...(d?.done ?? [])]);
  const lead = (id: Col) => (id === "working" ? pending.map((s) => <StartingCard key={s.id} s={s} />) : null);
  const count = (id: Col) => byCol[id].length + (id === "working" ? pending.length : 0);
  const busy = new Set(d?.busy ?? []);

  const tasks = useMemo(() => [...(d?.threads ?? []), ...(d?.done ?? [])].filter((t) => t.project === project), [d, project]);
  const byCol = useMemo(() => {
    const m: Record<Col, ThreadView[]> = { todo: [], working: [], waiting: [], blocked: [], paused: [], done: [] };
    for (const t of tasks) m[colOf(t)].push(t);
    m.todo.sort((a, b) => a.at - b.at); // oldest first: the order he wrote them down
    // A task whose every done-item is met rises to the top of its column with Close, before it's archived.
    for (const k of ["waiting", "paused"] as Col[]) m[k].sort((a, b) => Number(allMet(b)) - Number(allMet(a)));
    return m;
  }, [tasks]);
  const live = tasks.filter((t) => !t.archived);
  // The task whose chat has focus scrolls into view, so the board beside a chat shows where he is.
  useEffect(() => {
    if (!focusSid) return;
    const t = tasks.find((x) => x.sessions.some((y) => y.id === focusSid));
    if (t) rootRef.current?.querySelector(`[data-task="${CSS.escape(t.id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusSid, tasks.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { ensureDod(live); }, [live.map((t) => t.id + t.at).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!note) return; const x = setTimeout(() => setNote(null), 3500); return () => clearTimeout(x); }, [note]);

  // Other projects with work going, for the switcher: most tasks needing him first.
  const others = useMemo(() => {
    const m = new Map<string, { n: number; waiting: number; cwd: string }>();
    for (const t of d?.threads ?? []) {
      if (t.project === project) continue;
      const e = m.get(t.project) ?? { n: 0, waiting: 0, cwd: t.cwd };
      e.n++; if (t.state === "waiting") e.waiting++;
      m.set(t.project, e);
    }
    return [...m.entries()].sort((a, b) => b[1].waiting - a[1].waiting || b[1].n - a[1].n).slice(0, 8);
  }, [d, project]);

  const start = async (t: ThreadView) => {
    setStarting((s) => new Set(s).add(t.id));
    try {
      const r = await startAsk({ project, cwd: t.cwd || cwd, at: 0 }, t.title, { mode: perm, model });
      if (r.sid) await threadPost({ action: "start", id: t.id, sessionId: r.sid });
      else setNote("Started, but the chat's id didn't arrive — it will show up under Paused or Working.");
    } catch (e) { setNote(`Couldn't start: ${(e as Error).message}`); }
    setStarting((s) => { const n = new Set(s); n.delete(t.id); return n; });
  };
  const moveTo = (t: ThreadView, to: Col) => {
    const from = colOf(t);
    if (from === to) return;
    if (to === "done") { void threadPost({ action: "archive", id: t.id }); return; }
    if (t.archived) { void threadPost({ action: "unarchive", id: t.id }); return; }
    if (from === "todo" && to === "working") { void start(t); return; }
    setNote(from === "todo" ? "Drag it to Running (or press Start) to begin it." : "You, Running, Another task and Paused follow the chat — open it to move it along.");
  };
  const onDrop = (e: React.DragEvent, to: Col) => {
    e.preventDefault(); setOver(null);
    const t = tasks.find((x) => x.id === e.dataTransfer.getData("text/task"));
    if (t) moveTo(t, to);
  };

  const met = live.reduce((n, t) => n + (t.dod?.filter((x) => x.done).length ?? 0), 0);
  const all = live.reduce((n, t) => n + (t.dod?.length ?? 0), 0);

  const actionsFor = (t: ThreadView) => {
    const c = colOf(t);
    if (c === "todo") return <>
      <button className={`${mini} border-[var(--sakura)]/40`} disabled={starting.has(t.id)} onClick={() => void start(t)}>{starting.has(t.id) ? "Starting…" : "▶ Start"}</button>
      <button className={mini} onClick={() => void threadPost({ action: "drop", id: t.id })}>Drop</button>
    </>;
    if (t.archived) return <button className={mini} onClick={() => void threadPost({ action: "unarchive", id: t.id })}>Reopen</button>;
    if (allMet(t)) return <><span className="text-[11px] text-[#4ade80]/80">All met</span><button className={mini} onClick={() => void threadPost({ action: "archive", id: t.id })}>Close</button></>;
    return <button className={mini} onClick={() => moveTo(t, "done")} title="Move to Done">✓ Done</button>;
  };

  const activeOf = (t: ThreadView) => t.sessions.some((x) => openSids.includes(x.id));
  const card = (t: ThreadView, c: Col) => (
    <TaskCard key={t.id} t={t} busy={busy.has(t.id)} compact={c === "done"} fold={stacked} active={activeOf(t)} actions={actionsFor(t)}
      drag={stacked ? undefined : { onDragStart: (e) => { e.dataTransfer.setData("text/task", t.id); e.dataTransfer.effectAllowed = "move"; } }} />
  );
  const addForm = (
    <form onSubmit={(e) => { e.preventDefault(); const t = draft.trim(); if (t) { setDraft(""); void threadPost({ action: "queue", project, cwd, title: t }); } }}>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="+ Add a task"
        className="w-full rounded-lg border border-dashed border-white/15 bg-transparent px-2.5 py-1.5 text-[16px] text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-[var(--sakura)]/50 md:text-[13px]" />
    </form>
  );
  const colHead = (c: (typeof COLS)[number], n: number) => (
    <>
      <span className="h-2 w-2 rounded-full" style={{ background: c.tint }} />
      <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-neutral-400">{c.label}</span>
      <span className="text-[12px] text-neutral-600">{n}</span>
    </>
  );

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      {/* One header line at any width. The project name is the switcher: other projects, those
          needing him first, plus All chats — a chip strip was a second sideways scroll. */}
      <div className="relative flex items-center gap-2 pb-3">
        <button onClick={onClose} className={`${btn} px-2`} title="Back to all topics" aria-label="Back to all topics">←</button>
        <button onClick={() => setMenu((v) => !v)} className="flex min-w-0 items-center gap-1.5 rounded-lg px-1 text-left hover:bg-white/[0.05]" title="Switch project">
          <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight">{project}</h2>
          <span className="text-neutral-500">▾</span>
          {others.some(([, e]) => e.waiting) && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TINT.waiting }} title="Another project needs you" />}
        </button>
        {all > 0 && <span className="min-w-0 truncate text-[12px] text-neutral-500">{met}/{all} met</span>}
        <span className="flex-1" />
        {!stacked && <button onClick={onAllChats} className={btn}>All chats</button>}
        {menu && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
            <div className="absolute left-10 top-10 z-30 w-64 rounded-xl border border-white/10 bg-neutral-900 p-1 shadow-2xl">
              {others.map(([p, e]) => (
                <button key={p} onClick={() => { setMenu(false); onSwitch(p); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-neutral-200 hover:bg-white/10">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: e.waiting ? TINT.waiting : "transparent" }} />
                  <span className="min-w-0 flex-1 truncate">{p}</span>
                  <span className="text-[11px] text-neutral-500">{e.waiting ? `${e.waiting} need you · ` : ""}{e.n}</span>
                </button>
              ))}
              {others.length > 0 && <div className="my-1 border-t border-white/10" />}
              <button onClick={() => { setMenu(false); onAllChats(); }} className="w-full rounded-lg px-2 py-1.5 text-left text-[13px] text-neutral-300 hover:bg-white/10">All chats in {project}</button>
            </div>
          </>
        )}
      </div>

      {/* Whose move, in one line (V1): the count that matters first, the rest after it. */}
      {live.length > 0 && (() => {
        const n = (h: string) => live.filter((t) => t.wait?.holder === h).length;
        const rest = [n("machine") && `${n("machine")} running`, n("task") && `${n("task")} stuck on another task`, n("done") && `${n("done")} done`].filter(Boolean);
        return (
          <p className="mb-2 flex flex-wrap items-baseline gap-x-2 px-1">
            <span className="text-[18px] font-semibold" style={{ color: n("you") ? TINT.waiting : "rgb(115 115 115)" }}>{n("you")}</span>
            <span className="text-[13px] text-neutral-300">need you</span>
            {rest.length > 0 && <span className="text-[12px] text-neutral-500">· {rest.join(" · ")}</span>}
          </p>
        );
      })()}

      {note && <p className="mb-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] text-neutral-300">{note}</p>}

      {stacked ? (
        // One scroll axis: the bento column's own. Groups in urgency order; empty ones fold into a
        // single muted line; Done folds unless opened (remembered).
        <div className="flex flex-col gap-3 pb-6">
          <div>{addForm}</div>
          {STACK_ORDER.filter((id) => id !== "done" && count(id)).map((id) => {
            const c = COLS.find((x) => x.id === id)!;
            return (
              <section key={id}>
                <header className="mb-1.5 flex items-center gap-2 px-1" title={c.hint}>{colHead(c, count(id))}</header>
                <div className="flex flex-col gap-2">{lead(id)}{byCol[id].map((t) => card(t, id))}</div>
              </section>
            );
          })}
          {(() => {
            const empty = STACK_ORDER.filter((id) => id !== "done" && id !== "todo" && id !== "blocked" && !count(id));
            return empty.length > 0 && <p className="px-1 text-[11px] text-neutral-600">{empty.map((id) => `${COLS.find((x) => x.id === id)!.label} 0`).join(" · ")}</p>;
          })()}
          {byCol.done.length > 0 && (
            <section>
              <button onClick={() => { const v = !showDone; setShowDone(v); try { localStorage.setItem("minami.boardDone", v ? "1" : "0"); } catch { /* private mode */ } }}
                className="mb-1.5 flex items-center gap-2 px-1">{colHead(COLS.find((x) => x.id === "done")!, byCol.done.length)}<span className="text-[12px] text-neutral-600">{showDone ? "▾" : "›"}</span></button>
              {showDone && <div className="flex flex-col gap-2">{byCol.done.map((t) => card(t, "done"))}</div>}
            </section>
          )}
        </div>
      ) : (
      <div className="flex min-h-0 flex-1 gap-3 pb-2">
        {COLS.filter((c) => c.id !== "blocked" || byCol.blocked.length).map((c) => {
          const list = byCol[c.id];
          return (
            <section key={c.id}
              onDragOver={(e) => { e.preventDefault(); setOver(c.id); }} onDragLeave={() => setOver((o) => (o === c.id ? null : o))} onDrop={(e) => onDrop(e, c.id)}
              className={`flex min-w-0 flex-1 basis-0 flex-col rounded-2xl border bg-white/[0.02] ${over === c.id ? "border-[var(--sakura)]/60" : "border-white/[0.07]"}`}>
              <header className="flex items-center gap-2 px-3 pt-3 pb-2" title={c.hint}>{colHead(c, count(c.id))}</header>
              {c.id === "todo" && <div className="px-2 pb-2">{addForm}</div>}
              <div className="flex min-h-[4rem] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {lead(c.id)}
                {list.map((t) => card(t, c.id))}
                {!count(c.id) && <p className="px-1 py-3 text-center text-[11px] text-neutral-600">{c.hint}</p>}
              </div>
            </section>
          );
        })}
      </div>
      )}
    </div>
  );
}
