"use client";
// One task (a thread, §37) as a card: used by the expanded tile and the project board.
// The done-list is always on the card, never behind a tap — "progress and DoD is not there" (Thomas,
// 2026-10-28) was about exactly that. A task with no list gets one written by Minami (`ensureDod`), shown
// as a suggestion with Keep; Minami also ticks items the chat shows are met, marked so he can tell its
// ticks from his and see why. Progress is that list and nothing else: no phases, no percentages of work.
import { useState } from "react";
import { openThread, threadPost, type ThreadView } from "@/lib/use-threads";

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

function Dod({ t, busy, compact, fold }: { t: ThreadView; busy: boolean; compact?: boolean; fold?: boolean }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(!fold);
  const [, bump] = useState(0);
  const dod = t.dod ?? [];
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
  return (
    <div>
      <div className="flex items-center gap-2">
        <button onClick={toggle} className="block min-w-0 flex-1 text-left" title={open ? "Hide the done-list" : "Show the done-list"}><DodBar t={t} /></button>
        {fresh > 0 && !open && !compact && (
          <button onClick={toggle} className="shrink-0 rounded bg-[#4ade80]/10 px-1.5 py-0.5 text-[10px] text-[#4ade80]/90" title="Minami ticked items from the chat — see why">Minami ✓{fresh}</button>
        )}
        {t.dodPending && !compact && (
          <button onClick={() => void threadPost({ action: "dod.accept", id: t.id })} className="shrink-0 rounded-md border border-white/12 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-white/30 hover:text-neutral-100"
            title={`Minami's done-list${busy ? " (checking…)" : ""} — keep it`}>Keep</button>
        )}
      </div>
      {open && !compact && (
        <ul className="mt-1.5 space-y-0.5">
          {dod.map((d) => (
            <li key={d.id}>
              <label className="flex cursor-pointer items-start gap-2 text-[12px] leading-snug" title={d.by === "minami" ? `Ticked by Minami: ${d.why || "the chat says so"}. Tap to change.` : undefined}>
                <input type="checkbox" checked={d.done} onChange={() => void threadPost({ action: "dod.toggle", id: t.id, dodId: d.id })} className="mt-[2px] shrink-0 accent-[#4ade80]" />
                <span className={`min-w-0 flex-1 ${d.done ? "text-neutral-500 line-through" : t.dodPending ? "text-neutral-400" : "text-neutral-200"}`}>{d.t}</span>
                {d.by === "minami" && <span className="shrink-0 rounded bg-[#4ade80]/10 px-1 text-[9px] text-[#4ade80]/80">Minami</span>}
              </label>
              {d.by === "minami" && d.why && <p className="ml-5 text-[10px] leading-snug text-neutral-600">{d.why}</p>}
            </li>
          ))}
          <li>
            <form onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { void threadPost({ action: "dod.add", id: t.id, t: draft }); setDraft(""); } }}>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="+ add" className="ml-5 w-[calc(100%-1.25rem)] bg-transparent py-0.5 text-[16px] text-neutral-300 outline-none placeholder:text-neutral-600 md:text-[12px]" />
            </form>
          </li>
        </ul>
      )}
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
  return (
    <div draggable={!!drag} onDragStart={drag?.onDragStart} data-task={t.id}
      className={`flex min-w-0 flex-col gap-2 rounded-xl border bg-white/[0.035] ${compact ? "p-2.5" : "p-3"} ${active ? "border-[var(--sakura)]/70 ring-1 ring-[var(--sakura)]/40" : "border-white/10"} ${drag ? "cursor-grab active:cursor-grabbing" : ""} ${t.archived ? "opacity-70" : ""}`}>
      <button onClick={() => { if (t.sessions.length) { markSeen(t.id); openThread(t); } }} disabled={!t.sessions.length} className="min-w-0 text-left disabled:cursor-default" title={t.sessions.length ? "Open this task's chats" : undefined}>
        <span className="flex items-start gap-2">
          <span className={`mt-[6px] h-2 w-2 shrink-0 rounded-full ${st === "working" ? "animate-pulse" : ""}`} style={{ background: TINT[st] }} />
          <span className={`min-w-0 flex-1 font-medium leading-snug text-neutral-100 ${compact ? "truncate text-[13px]" : "line-clamp-2 text-[13.5px]"}`}>{t.title}</span>
        </span>
        <span className="mt-0.5 block truncate pl-4 text-[11px] text-neutral-500">
          {!t.archived && STATE[st] && <span style={{ color: st === "queued" ? undefined : TINT[st] }}>{STATE[st]} · </span>}
          {t.archived ? `done ${ago(t.doneAt ?? t.at)} ago` : ago(t.at)}
          {t.sessions.length > 0 && ` · ${t.sessions.length} chat${t.sessions.length > 1 ? "s" : ""}`}
        </span>
        {t.line && !compact && !fold && <span className="mt-1 line-clamp-2 pl-4 text-[12px] leading-snug text-neutral-400">{t.line}</span>}
        {t.line && fold && <span className="mt-1 line-clamp-1 pl-4 text-[12px] leading-snug text-neutral-400">{t.line}</span>}
      </button>
      {(!!t.dod?.length || !compact) && <div className="pl-4"><Dod t={t} busy={busy} compact={compact} fold={fold} /></div>}
      {actions && <div className="flex flex-wrap items-center gap-1.5 pl-4">{actions}</div>}
    </div>
  );
}
