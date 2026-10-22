"use client";
// A goal's part for Thomas, as Today's to-do rows, on the goal's own card (2026-10-22). It used to be a read-only
// checklist with "Tick on Today →": the tick was stored on Today, so the card sent him there to make it, and one
// to-do had two homes. The tick is still stored on Today (the heartbeat copied the to-do into today's day file;
// lib/goals.ts hands us its id), but it is MADE here, through the same /api/today ops Today's own rows use:
//   toggle · comment · handoff ("Do it with Minami") · resolve (a question's answer).
// So the two pages can't disagree, and neither one sends him to the other.
import { useEffect, useState } from "react";
import type { Goal, GoalQuestion, GoalTodo } from "@/lib/goals";
import { useOpenChat } from "@/components/shell/Drawer";
import { K, mix, hhmm, EASE } from "../today/ui";
import { stateOf, useHandoffLive, type LiveTile } from "../today/live";
import { CHAT_STATE } from "./Asks";

const AMBER = "#ffd27a";

async function today(date: string, body: Record<string, unknown>): Promise<{ ok?: boolean; error?: string; sessionId?: string }> {
  try {
    const r = await fetch("/api/today", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date, ...body }) }).then((r) => r.json());
    return r.error ? { error: r.error } : { ok: true, ...r };
  } catch { return { error: "Couldn't save — check the connection." }; }
}

export function GoalTodos({ g, onChanged }: { g: Goal; onChanged: () => void }) {
  const t = g.today;
  const sids = (t?.todos ?? []).flatMap((x) => (x.day?.handoff ? [x.day.handoff.sessionId] : []));
  const live = useHandoffLive(sids);
  if (!t || (!t.todos.length && !t.questions.length)) return null;
  const left = t.todos.filter((x) => !x.done);
  const min = left.reduce((s, x) => s + (x.est_min || 0), 0);
  const open = left.length + t.questions.filter((q) => !q.day?.resolved).length;
  // Undone first, the way Today lists them; a done row stays (struck through) so a mis-tick can be undone here.
  const todos = [...t.todos].sort((a, b) => Number(!!a.done) - Number(!!b.done));
  return (
    <div className="overflow-hidden rounded-2xl" style={{ background: open ? mix(AMBER, 6) : "rgba(255,255,255,.04)", border: `1px solid ${open ? mix(AMBER, 28) : K.line}` }}>
      <div className="px-4 pt-3 text-[13px] font-semibold" style={{ color: open ? AMBER : K.muted }}>
        {open ? `Needs you · ${open}${min ? ` · ${min} min` : ""}` : "Your part today — done"}
      </div>
      <ul className="mt-1">
        {todos.map((x, i) => <TodoRow key={x.text} x={x} date={t.date} first={i === 0} tile={x.day?.handoff ? live[x.day.handoff.sessionId] : undefined} onChanged={onChanged} />)}
        {t.questions.map((q) => <QuestionRow key={q.question} q={q} date={t.date} onChanged={onChanged} />)}
      </ul>
    </div>
  );
}

function TodoRow({ x, date, first, tile, onChanged }: { x: GoalTodo; date: string; first: boolean; tile: LiveTile | undefined; onChanged: () => void }) {
  const openChat = useOpenChat();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Optimistic tick: the goals feed refreshes after the save, and until then the circle must not snap back.
  const [done, setDone] = useState<boolean | null>(null);
  useEffect(() => setDone(null), [x.done]); // the feed caught up (or Today changed it): its word wins again
  const isDone = done ?? !!x.done;
  const id = x.day?.id, h = x.day?.handoff;
  const chat = h ? stateOf(tile) : null;
  const run = async (body: Record<string, unknown>, clear = false) => {
    if (!id) return;
    setBusy(true); setErr("");
    const r = await today(date, { id, ...body });
    if (r.error) setErr(r.error); else { if (clear) setNote(""); onChanged(); }
    setBusy(false);
    return r;
  };
  const tick = async () => {
    const next = !isDone;
    setDone(next);
    const r = await run({ op: "toggle", done: next });
    if (r?.error) setDone(null);
  };
  const why = chat === "needs" ? tile?.need?.summary : x.day?.done_by === "auto" ? x.day.done_evidence : x.why;
  return (
    <li style={{ borderTop: first ? undefined : `1px solid ${K.line}` }}>
      <div className="flex items-center gap-3 px-4 py-2.5">
        <button onClick={tick} disabled={!id || busy} aria-label={isDone ? "Mark not done" : "Mark done"}
          title={id ? undefined : "Not on today's plan yet — the 07:30 heartbeat puts it there"}
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[12px] transition-all active:scale-90 disabled:opacity-40"
          style={{ background: isDone ? K.accent : "transparent", border: `1.5px solid ${isDone ? K.accent : K.line2}`, color: "#fff", transitionTimingFunction: EASE }}>{isDone ? "✓" : ""}</button>
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
          <span className={`min-w-0 flex-1 text-[15px] font-medium leading-snug ${isDone ? "line-through" : ""} ${open ? "" : "line-clamp-2"}`} style={{ color: isDone ? K.faint : K.ink, textDecorationColor: K.line2 }}>{x.text}</span>
          {isDone && x.day?.done_by === "auto" && <span className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px]" style={{ background: mix(AMBER, 18), color: AMBER, fontFamily: "var(--today-mono)" }}>AUTO</span>}
          {chat && !isDone && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] ${chat === "running" ? "animate-pulse" : ""}`}
            style={{ background: mix(CHAT_STATE[chat].color, 18), color: CHAT_STATE[chat].color, fontFamily: "var(--today-mono)" }}>{CHAT_STATE[chat].dot} {CHAT_STATE[chat].label}</span>}
          {x.est_min && !isDone ? <span className="shrink-0 text-[11px] tabular-nums" style={{ color: K.faint, fontFamily: "var(--today-mono)" }}>{x.est_min}m</span> : null}
          <span className="shrink-0 text-[12px] transition-transform" style={{ color: K.faint, transform: open ? "rotate(90deg)" : "none" }}>›</span>
        </button>
      </div>
      {why && !open && !isDone && <p className="-mt-1.5 truncate pb-2.5 pl-[50px] pr-4 text-[12.5px]" style={{ color: chat === "needs" ? AMBER : K.faint }}>{why}</p>}
      {open && (
        <div className="flex flex-col gap-3 pb-4 pl-[50px] pr-4">
          {x.why && <p className="text-[13px] leading-snug" style={{ color: K.faint }}>{x.why}</p>}
          {chat === "needs" && tile?.need && <p className="text-[13px] leading-snug" style={{ color: AMBER }}>Minami is waiting on you: {tile.need.summary}</p>}
          {isDone && x.day?.done_by === "auto" && x.day.done_evidence && <p className="text-[13px] leading-snug" style={{ color: AMBER }}>Ticked automatically — {x.day.done_evidence} Untick it if that's wrong.</p>}
          {!!x.day?.comments?.length && <ul className="flex flex-col gap-1.5">{x.day.comments.map((c, i) => (
            <li key={i} className="text-[13px] leading-snug" style={{ color: K.muted }}>
              <span style={{ color: K.faint, fontFamily: "var(--today-mono)", fontSize: 11 }}>{hhmm(c.at)}{c.to === "chat" ? " · to Minami" : c.to === "instruction" ? " · instruction" : ""} </span>{c.text}</li>))}</ul>}
          {!id ? <p className="text-[13px]" style={{ color: K.faint }}>Not on today's plan yet — the 07:30 heartbeat puts it there; then it ticks here and on Today.</p> : <>
            {/* One box, two uses, as on Today: a comment, or the instruction "Do it with Minami" starts the chat with. */}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={note.includes("\n") || note.length > 60 ? 3 : 1}
              placeholder={h ? "Tell Minami something about this task…" : "Comment, or tell Minami how to do it…"}
              className="w-full resize-none rounded-2xl bg-transparent px-3.5 py-2.5 text-[13.5px] leading-snug outline-none placeholder:text-white/35"
              style={{ border: `1px solid ${K.line2}`, color: K.ink }} />
            <div className="flex flex-wrap items-center gap-2">
              {h ? <>
                  {note.trim() && <Btn accent disabled={busy} onClick={() => run({ op: "comment", text: note.trim() }, true)}>{busy ? "Sending…" : "Send to Minami"}</Btn>}
                  <button onClick={() => openChat(h.sessionId)} className="text-[12.5px] hover:text-white" style={{ color: K.faint }}>Open the full chat →</button>
                </>
                : <>
                  <Btn accent disabled={busy || isDone} onClick={() => run({ op: "handoff", kind: "todo", how: "do", ...(note.trim() ? { note: note.trim() } : {}) }, true)}>
                    {busy ? "Starting…" : note.trim() ? "Do it with Minami + this" : "Do it with Minami"}</Btn>
                  {note.trim() && <Btn disabled={busy} onClick={() => run({ op: "comment", text: note.trim() }, true)}>Comment</Btn>}
                </>}
              {err && <span className="text-[12.5px]" style={{ color: "#ff8a8d" }}>{err}</span>}
            </div>
          </>}
        </div>
      )}
    </li>
  );
}

// A question the runner left for him, answered with one tap on the card (Today's resolve op), instead of "answer it
// on Today". Multi-select and free-text answers still want Today's decide flow; those say so.
function QuestionRow({ q, date, onChanged }: { q: GoalQuestion; date: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const id = q.day?.id, res = q.day?.resolved;
  const answer = async (label: string) => {
    if (!id) return;
    setBusy(true); setErr("");
    const r = await today(date, { op: "resolve", id, answer: label });
    if (r.error) setErr(r.error); else onChanged();
    setBusy(false);
  };
  return (
    <li className="px-4 py-3" style={{ borderTop: `1px solid ${K.line}` }}>
      <p className="text-[14.5px] leading-snug" style={{ color: res ? K.faint : AMBER }}>{q.question}</p>
      {res ? <p className="mt-1.5 text-[13px]" style={{ color: K.muted }}>You answered: <b style={{ color: K.ink }}>{([] as string[]).concat(res.answer).join(", ")}</b></p>
        : !id || q.day?.multiSelect ? <p className="mt-1.5 text-[12.5px]" style={{ color: K.faint }}>{id ? "Several answers allowed — pick them on Today." : "On today's plan after the 07:30 heartbeat."}</p>
        : (
          <div className="mt-2 flex flex-wrap gap-2">
            {q.options.map((o) => (
              <button key={o.label} title={o.description} disabled={busy} onClick={() => answer(o.label)}
                className="rounded-full px-3 py-1.5 text-[13px] hover:brightness-125 disabled:opacity-50" style={{ background: "rgba(255,255,255,.07)", border: `1px solid ${K.line2}`, color: K.ink }}>{o.label}</button>
            ))}
          </div>
        )}
      {err && <p className="mt-1.5 text-[12.5px]" style={{ color: "#ff8a8d" }}>{err}</p>}
    </li>
  );
}

function Btn({ children, accent, disabled, onClick }: { children: React.ReactNode; accent?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled} className="h-8 rounded-full px-3.5 text-[13px] font-semibold disabled:opacity-50"
      style={accent ? { background: K.accent, color: "#fff" } : { background: "rgba(255,255,255,.07)", border: `1px solid ${K.line2}`, color: K.muted }}>{children}</button>
  );
}
