"use client";
// One task (a thread, §37) as a card: used by the expanded tile and the project board.
// The done-list is always on the card, never behind a tap — "progress and DoD is not there" (Thomas,
// 2026-10-28) was about exactly that. A task with no list gets one written by Minami (`ensureDod`), shown
// as a suggestion with Keep; Minami also ticks items the chat shows are met, marked so he can tell its
// ticks from his and see why. Progress is that list and nothing else: no phases, no percentages of work.
import { useState } from "react";
import { useSetting } from "@/lib/use-settings";
import { doDodItem, openThread, threadPost, type ThreadView } from "@/lib/use-threads";
import type { AgentMode } from "@/lib/use-agent";
import { GATE_LABEL, nextGate, paceLine, runPlan } from "@/lib/task-pace";

export const TINT = { working: "#f0a868", waiting: "var(--sakura)", idle: "rgba(255,255,255,0.22)", queued: "rgba(255,255,255,0.12)" } as const;
const STATE = { working: "working", waiting: "waiting on you", idle: "", queued: "to do" } as const;
const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60e3);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const mini = "rounded-md border border-white/12 px-2 py-0.5 text-[11px] text-neutral-300 transition-colors hover:border-white/30 hover:text-neutral-100 pointer-coarse:py-1.5";

/** Segmented bar: one segment per done-list item. Minami's ticks are the paler green. */
export function DodBar({ t, tall }: { t: ThreadView; tall?: boolean }) {
  const dod = t.dod ?? [];
  const done = dod.filter((d) => d.done).length;
  return (
    <div className="flex items-center gap-2">
      <div className={`flex flex-1 gap-[3px] ${tall ? "h-1.5" : "h-1"}`}>
        {dod.map((d) => <span key={d.id} className="flex-1 rounded-full" style={{ background: !d.done ? "rgba(255,255,255,0.1)" : d.by === "minami" ? "#4ade80aa" : "#4ade80" }} />)}
      </div>
      <span className={`shrink-0 text-[11px] tabular-nums ${done === dod.length && dod.length ? "text-[#4ade80]" : "text-neutral-500"}`}>{done}/{dod.length}</span>
    </div>
  );
}

// When he last opened a card's list, so "Minami ticked n" counts only ticks he hasn't seen. Recorded by
// opening, never set by hand.
const seenKey = (id: string) => `minami.dodSeen.${id}`;
const seenAt = (id: string) => { try { return Number(localStorage.getItem(seenKey(id)) || 0); } catch { return 0; } };
const markSeen = (id: string) => { try { localStorage.setItem(seenKey(id), String(Date.now())); } catch { /* private mode */ } };

/** One done-item, readable at a glance: a round check, the words at full size, Minami's reason under a
 *  tick it made, and on the open items a "Minami, do it" that hands the item to the task's chat.
 *  A status pill marks the item being worked on (or "next" when none is) — the first open item — clicking the bar to remember what to do next was the habit this
 *  replaces (Thomas, 2026-10-28). */
// Each item's status, so the card says which one is being worked on rather than only which is next
// (Thomas, 2026-10-28). "on" comes from `doing` (▶ Do it, or Minami reading the chat — /api/threads
// evaluate) combined with the task's live state; "next" only when nothing is on.
type ItemStatus = "done" | "on" | "asks" | "started" | "next" | "todo";
const PILL: Record<Exclude<ItemStatus, "done" | "todo">, { label: string; cls: string }> = {
  on: { label: "Minami on it", cls: "bg-[#f0a868]/15 text-[#f0a868]" },
  asks: { label: "needs you", cls: "bg-[var(--sakura)]/20 text-[var(--sakura)]" },
  started: { label: "started", cls: "bg-white/10 text-neutral-300" },
  next: { label: "next", cls: "bg-white/[0.07] text-neutral-400" },
};
function statusesOf(t: ThreadView): Map<string, ItemStatus> {
  const dod = t.dod ?? [];
  const cur = dod.filter((d) => !d.done && d.doing).sort((a, b) => (b.doing ?? 0) - (a.doing ?? 0))[0];
  const next = cur ? undefined : dod.find((d) => !d.done);
  return new Map(dod.map((d): [string, ItemStatus] => [d.id, d.done ? "done"
    : d === cur ? (t.state === "working" ? "on" : t.state === "waiting" ? "asks" : "started")
    // A run stopped at a gate is his move: the gated next item says so, not just "next".
    : d === next ? (d.gate && t.state === "waiting" ? "asks" : "next") : "todo"]));
}

function DodItem({ t, d, status, onDo, doing }: { t: ThreadView; d: NonNullable<ThreadView["dod"]>[number]; status: ItemStatus; onDo?: () => void; doing: boolean }) {
  const lead = status !== "done" && status !== "todo";
  const pill = status !== "done" && status !== "todo" ? PILL[status] : null;
  return (
    <li className={`group/item flex items-start gap-2 rounded-lg px-1.5 py-1 ${status === "on" ? "bg-[#f0a868]/[0.08]" : lead ? "bg-[var(--sakura)]/[0.06]" : ""}`}>
      <button onClick={() => void threadPost({ action: "dod.toggle", id: t.id, dodId: d.id })} aria-label={d.done ? "Mark not done" : "Mark done"}
        title={d.by === "minami" ? `Ticked by Minami: ${d.why || "the chat says so"}. Tap to change.` : undefined}
        className={`mt-[2px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none ${d.done ? "border-[#4ade80] bg-[#4ade80]/20 text-[#4ade80]" : status === "on" ? "border-[#f0a868]" : lead ? "border-[var(--sakura)]/70" : "border-white/25 hover:border-white/50"}`}>
        {d.done ? "✓" : status === "on" ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#f0a868]" /> : ""}
      </button>
      <span className="min-w-0 flex-1">
        <span className={`block text-[13px] leading-[1.35] ${d.done ? "text-neutral-500" : t.dodPending ? "text-neutral-300" : "text-neutral-100"}`}>
          {pill && <span className={`mr-1.5 rounded px-1 py-px align-[1px] text-[9px] font-semibold uppercase tracking-wider ${pill.cls}`}>{pill.label}</span>}
          {d.t}
        </span>
        {d.by === "minami" && d.done && (
          <span className="mt-0.5 block text-[11px] leading-snug text-neutral-500">
            <span className="text-[#4ade80]/80">Minami:</span> {d.why || "the chat says so"}
            {/* The words in the chat that met it, checked to be really there (evaluate in /api/threads).
                Tapping opens the chat they came from. */}
            {d.quote && (
              <button onClick={() => t.sessions.length && openThread(t)} title="Open the chat this came from"
                className="mt-1 block w-full border-l-2 border-[#4ade80]/30 pl-2 text-left italic text-neutral-400 hover:text-neutral-200">
                “{d.quote}”{d.quoteBy && <span className="not-italic text-neutral-600"> — {d.quoteBy === "Thomas" ? "you" : "Minami"}</span>}
              </button>
            )}
          </span>
        )}
      </span>
      {!d.done && <GateChip t={t} d={d} />}
      {!d.done && onDo && status !== "on" && (
        <button onClick={onDo} disabled={doing} title="Send this item to the task's chat and let Minami do it"
          className={`shrink-0 rounded-md border border-[var(--sakura)]/40 px-1.5 py-0.5 text-[10px] text-[var(--sakura)] transition-opacity hover:bg-[var(--sakura)]/10 disabled:opacity-50 ${lead ? "" : "opacity-0 group-hover/item:opacity-100 pointer-coarse:opacity-100"}`}>
          {doing ? "sending…" : "▶ Do it"}
        </button>
      )}
    </li>
  );
}

/** Where a run stops for him (lib/task-pace.ts). A gated item shows its chip; an ungated one shows "auto"
 *  on hover only, so the usual case adds nothing to read. One tap cycles auto → your pick → asks you, and
 *  his choice is never reclassified by Haiku. */
function GateChip({ t, d }: { t: ThreadView; d: NonNullable<ThreadView["dod"]>[number] }) {
  const g = d.gate ?? null;
  const tip = `${g ? `${GATE_LABEL[g]}${d.gateWhy ? ` — ${d.gateWhy}` : ""}` : "Minami does this one and moves on"}${d.gateBy ? " (your setting)" : ""}. Tap to change.`;
  return (
    <button onClick={() => void threadPost({ action: "gate", id: t.id, dodId: d.id, gate: nextGate(g) })} title={tip}
      className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wider transition-opacity ${g ? "bg-[var(--sakura)]/15 text-[var(--sakura)]" : "text-neutral-600 opacity-0 hover:text-neutral-300 group-hover/item:opacity-100 pointer-coarse:opacity-100"}`}>
      {g ? `✋ ${GATE_LABEL[g]}` : "auto"}
    </button>
  );
}

const RUN = "__run";

export function Dod({ t, busy, compact, fold }: { t: ThreadView; busy: boolean; compact?: boolean; fold?: boolean }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(!fold);
  const [doing, setDoing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [perm] = useSetting<Exclude<AgentMode, "plan">>("permMode", "bypassPermissions");
  const [model] = useSetting<string | null>("chatModel", null);
  const [, bump] = useState(0);
  const dod = t.dod ?? [];
  // A done task shows no open items, on any surface (Thomas, 2026-10-28: the board "shows … those still
  // have to do subtask even when I told that the mother task is done"). His word closes the whole task;
  // listing what was left, or a 2/3 bar, reads as unfinished work. Reopen brings the list back.
  if (t.archived) {
    if (!dod.length) return null;
    return <p className="text-[11px] text-[#4ade80]/80">✓ Done{t.closedWhy && t.closedWhy !== "closed from the chat" ? <span className="italic text-neutral-500"> — “{t.closedWhy}”</span> : ""}</p>;
  }
  if (!dod.length) {
    if (compact) return null;
    return busy
      ? <p className="animate-pulse text-[11px] text-neutral-500">Minami is writing a done-list…</p>
      : (
        <form onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { void threadPost({ action: "dod.add", id: t.id, t: draft }); setDraft(""); } }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="+ what does done look like?" className="w-full rounded-md border border-dashed border-white/12 bg-transparent px-2 py-1 text-[16px] text-neutral-200 outline-none placeholder:text-neutral-600 md:text-[12px]" />
        </form>
      );
  }
  const fresh = dod.filter((d) => d.by === "minami" && d.done && (d.at ?? 0) > seenAt(t.id)).length;
  const toggle = () => { if (!open) { markSeen(t.id); bump((n) => n + 1); } setOpen((v) => !v); };
  const status = statusesOf(t);
  const leadId = dod.find((d) => { const x = status.get(d.id); return x !== "done" && x !== "todo"; })?.id;
  const canDo = t.sessions.length > 0 && !t.archived;
  const plan = runPlan(dod);
  const pace = paceLine(dod);
  const doIt = canDo ? (id: string) => async () => {
    setDoing(id); setErr(null);
    const e = await doDodItem(t, id === RUN ? null : id, { mode: perm, model });
    setDoing(null); if (e) setErr(e);
  } : null;
  const shown = open ? dod : dod.filter((d) => d.id === leadId);
  return (
    <div>
      <div className="flex items-center gap-2">
        <button onClick={toggle} className="block min-w-0 flex-1 text-left" title={open ? "Fold the done-list" : "Show the whole done-list"}><DodBar t={t} /></button>
        {fresh > 0 && !open && !compact && (
          <button onClick={toggle} className="shrink-0 rounded bg-[#4ade80]/10 px-1.5 py-0.5 text-[10px] text-[#4ade80]/90" title="Minami ticked items from the chat — see why">Minami ✓{fresh}</button>
        )}
        {t.dodPending && !compact && (
          <button onClick={() => void threadPost({ action: "dod.accept", id: t.id })} className="shrink-0 rounded-md border border-white/12 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-white/30 hover:text-neutral-100"
            title={`Minami's done-list${busy ? " (checking…)" : ""} — keep it`}>Keep</button>
        )}
      </div>
      {/* How the task runs: on its own to the end, or to a gate where it waits for him. ▶ Run sends the
          whole stretch in one message, so the ungated items need no click each (Thomas, 2026-10-28). */}
      {!compact && pace && (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500">
          <span className="min-w-0 flex-1 truncate">{pace}</span>
          {doIt && plan.run.length > 0 && t.state !== "working" && (
            <button onClick={doIt(RUN)} disabled={!!doing} title="Send every item up to the first gate to the task's chat, in one go"
              className="shrink-0 rounded-md bg-[var(--sakura)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--sakura)] hover:bg-[var(--sakura)]/25 disabled:opacity-50 pointer-coarse:py-1.5">
              {doing === RUN ? "sending…" : plan.run.length > 1 ? `▶ Run ${plan.run.length}` : "▶ Run"}
            </button>
          )}
        </div>
      )}
      {!compact && shown.length > 0 && (
        <ul className="-mx-1.5 mt-1.5 space-y-0.5">
          {shown.map((d) => <DodItem key={d.id} t={t} d={d} status={status.get(d.id) ?? "todo"} doing={doing === d.id} onDo={doIt ? doIt(d.id) : undefined} />)}
          {open && (
            <li>
              <form onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { void threadPost({ action: "dod.add", id: t.id, t: draft }); setDraft(""); } }}>
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="+ add" className="ml-7 w-[calc(100%-1.75rem)] bg-transparent py-0.5 text-[16px] text-neutral-300 outline-none placeholder:text-neutral-600 md:text-[12px]" />
              </form>
            </li>
          )}
        </ul>
      )}
      {!open && !compact && dod.length > shown.length && (
        <button onClick={toggle} className="mt-0.5 pl-5 text-[11px] text-neutral-600 hover:text-neutral-300">all {dod.length} items</button>
      )}
      {err && <p className="mt-1 text-[11px] text-red-300/80">{err}</p>}
    </div>
  );
}

/** `fold`: the done-list starts closed (bar + n/m only) — the board beside a chat, where a 400px card
 *  showed one and a half tasks. `compact`: a Done card — title, when, the bar. `active`: its chat is the
 *  one open in the panel. */
export function TaskCard({ t, busy, compact, fold, active, actions, drag }: {
  t: ThreadView; busy: boolean; compact?: boolean; fold?: boolean; active?: boolean;
  actions?: React.ReactNode;
  drag?: { onDragStart: (e: React.DragEvent) => void };
}) {
  const st = t.archived ? "idle" : t.state;
  const open = () => { if (t.sessions.length) { markSeen(t.id); openThread(t); } };
  // The whole card opens the task, not just the title block (Thomas, 2026-10-28: on a long card he "had
  // to scroll all the way up to click on the top area"). Clicks on the card's own controls (tick, Do it,
  // Keep, ✓ Done, the add field) keep their meaning, and a drag-select of text is not a click.
  const onCard = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select, form, label")) return;
    if (window.getSelection()?.toString()) return;
    open();
  };
  return (
    <div draggable={!!drag} onDragStart={drag?.onDragStart} data-task={t.id} onClick={onCard}
      className={`flex min-w-0 flex-col gap-2 rounded-xl border bg-white/[0.035] ${compact ? "p-2.5" : "p-3"} ${active ? "border-[var(--sakura)]/70 ring-1 ring-[var(--sakura)]/40" : "border-white/10"} ${drag ? "cursor-grab active:cursor-grabbing" : t.sessions.length ? "cursor-pointer" : ""} ${t.sessions.length ? "transition-colors hover:border-white/20 hover:bg-white/[0.05]" : ""} ${t.archived ? "opacity-70" : ""}`}>
      <button onClick={open} disabled={!t.sessions.length} className="min-w-0 text-left disabled:cursor-default" title={t.sessions.length ? "Open this task's chats" : undefined}>
        <span className="flex items-start gap-2">
          <span className={`mt-[6px] h-2 w-2 shrink-0 rounded-full ${st === "working" ? "animate-pulse" : ""}`} style={{ background: TINT[st] }} />
          <span className={`min-w-0 flex-1 font-medium leading-snug text-neutral-100 ${compact ? "truncate text-[13px]" : "line-clamp-2 text-[13.5px]"}`}>{t.title}</span>
        </span>
        <span className="mt-0.5 block truncate pl-4 text-[11px] text-neutral-500">
          {active && <span className="font-medium text-[var(--sakura)]">● chatting now · </span>}
          {!t.archived && STATE[st] && <span style={{ color: st === "queued" ? undefined : TINT[st] }}>{STATE[st]} · </span>}
          {t.archived ? `done ${ago(t.doneAt ?? t.at)} ago` : ago(t.at)}
          {t.sessions.length > 0 && ` · ${t.sessions.length} chat${t.sessions.length > 1 ? "s" : ""}`}
        </span>
        {t.line && !compact && !fold && <span className="mt-1 line-clamp-2 pl-4 text-[12px] leading-snug text-neutral-400">{t.line}</span>}
        {t.line && fold && <span className="mt-1 line-clamp-1 pl-4 text-[12px] leading-snug text-neutral-400">{t.line}</span>}
      </button>
      {(!!t.dod?.length || !compact) && <div className="pl-4"><Dod t={t} busy={busy} compact={compact} fold={fold} /></div>}
      {/* Every open card can be closed by hand — the tile had no way to (Thomas, 2026-10-28). The board
          passes its own actions; the tile gets this. */}
      {actions ? <div className="flex flex-wrap items-center gap-1.5 pl-4">{actions}</div>
        : !t.archived && t.state !== "queued" && (
          <div className="pl-4"><button onClick={() => void threadPost({ action: "archive", id: t.id })} title="Mark this task done and move it to Done"
            className="rounded-md border border-white/12 px-2 py-0.5 text-[11px] text-neutral-400 transition-colors hover:border-[#4ade80]/50 hover:text-[#4ade80] pointer-coarse:py-1.5">✓ Done</button></div>
        )}
    </div>
  );
}
