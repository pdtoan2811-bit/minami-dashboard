"use client";
/**
 * A flagged item with Today's handling (§34): a tick to resolve it, a tap to open it, comments, "Ask Minami", and a
 * fold for what got resolved — by Thomas, or AUTO when the source stopped flagging it. The store and the auto-check are
 * lib/attention.ts; this is only the hand on it, so any panel that flags things can use the same row.
 */
import Link from "next/link";
import { useState } from "react";
import type { AttnView } from "@/lib/attention";
import { EASE, K, hhmm, mix } from "@/app/today/ui";

const MONO = { fontFamily: "var(--today-mono)" } as const;
const AMBER = "#f3c766", GREEN = "#8fe0b8";

async function post(body: Record<string, unknown>): Promise<{ att?: AttnView; sessionId?: string; error?: string }> {
  return fetch("/api/attention", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json()).catch((e) => ({ error: String(e) }));
}

const when = (iso: string) => {
  const d = new Date(iso), today = new Date().toDateString() === d.toDateString();
  return today ? hhmm(iso) : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + hhmm(iso);
};

export type AttnAsk = { runner: string; context: string };

export function AttentionRow({ att, tag, title, line, detail, reasons = ["Fixed", "Dropped"], ask, onChanged }: {
  att: AttnView; tag?: React.ReactNode; title: React.ReactNode; line?: React.ReactNode; detail?: React.ReactNode;
  /** One-tap ways it got handled, saved as the resolve's `how`. */
  reasons?: string[]; ask?: AttnAsk; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const run = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr("");
    const r = await post({ key: att.key, ...body });
    setBusy(null);
    if (r.error) { setErr(r.error); return false; }
    setNote(""); onChanged(); return true;
  };
  const askMinami = () => ask && run("ask", { op: "ask", text: note.trim() || "Look into this and tell me how to clear it", runner: ask.runner, context: ask.context });
  const resolve = (how?: string) => run(how || "resolve", { op: "resolve", how, note: note.trim() || undefined });

  return (
    <li className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-2.5">
      <button onClick={() => resolve()} disabled={!!busy} aria-label="Resolve" title="Resolve: it's handled"
        className="mt-0.5 flex h-[20px] w-[20px] items-center justify-center rounded-full transition-all hover:border-white/60 active:scale-90"
        style={{ border: `1.5px solid ${K.line2}`, transitionTimingFunction: EASE }} />
      <span className="min-w-0">
        <button onClick={() => setOpen(!open)} className="flex w-full min-w-0 items-baseline gap-x-2 text-left">
          {tag}
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{title}</span>
          {att.changed && <span title="It was resolved, and the problem has changed since" className="shrink-0 rounded-full px-1.5 py-px text-[10px]" style={{ ...MONO, background: mix(AMBER, 18), color: AMBER }}>CHANGED</span>}
          {!!att.comments.length && <span className="shrink-0 text-[11px]" style={{ ...MONO, color: K.faint }}>💬 {att.comments.length}</span>}
          <span className="shrink-0 text-[12px] transition-transform" style={{ color: K.faint, transform: open ? "rotate(90deg)" : "none" }}>›</span>
        </button>
        {line && !open && <span className="line-clamp-2 block text-[12.5px] leading-snug" style={{ color: K.muted }}>{line}</span>}
        {/* Always there, not behind the tap (Thomas, 2026-10-23: "Minami button and input text please??"). Enter asks
            Minami; Comment only saves the note on the flag. */}
        <form className="mt-1.5 flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (!busy) askMinami(); }}>
          <input value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} disabled={busy === "ask"}
            placeholder={busy === "ask" ? "Starting a chat…" : ask ? "Tell Minami what to do, or comment…" : "Comment…"}
            className="h-8 min-w-0 flex-1 rounded-full bg-transparent px-3.5 text-[13px] outline-none placeholder:text-white/35 disabled:opacity-60"
            style={{ border: `1px solid ${K.line2}`, color: K.ink }} />
          {note.trim() && <button type="button" disabled={!!busy} onClick={() => run("comment", { op: "comment", text: note.trim() })}
            className="h-8 shrink-0 rounded-full px-3 text-[12px] hover:text-white" style={{ background: "rgba(255,255,255,.06)", color: K.muted }}>Comment</button>}
          {ask && <button type="submit" disabled={!!busy} className="h-8 shrink-0 rounded-full px-3.5 text-[12px] font-semibold text-white disabled:opacity-60"
            style={{ background: K.accent }}>{busy === "ask" ? "…" : "Minami ↵"}</button>}
          {att.chat && !open && <Link href={`/?open=${att.chat}`} title="Open Minami's chat about this" className="shrink-0 text-[12px] hover:text-white" style={{ color: K.accentBright }}>chat →</Link>}
        </form>
        {err && !open && <span className="mt-1 block text-[12.5px]" style={{ color: "#ff8a8d" }}>{err}</span>}
        {open && (
          <span className="mt-1.5 flex flex-col gap-2.5">
            {(detail ?? line) && <span className="block whitespace-pre-line text-[13px] leading-snug" style={{ color: K.muted }}>{detail ?? line}</span>}
            {att.since && <span className="block text-[11.5px]" style={{ ...MONO, color: K.faint }}>flagged since {when(att.since)}{att.changed ? " · changed since you last resolved it" : ""}</span>}
            {!!att.comments.length && <ul className="flex flex-col gap-1">{att.comments.map((c, i) => (
              <li key={i} className="text-[13px] leading-snug" style={{ color: K.muted }}>
                <span style={{ ...MONO, color: K.faint, fontSize: 11 }}>{when(c.at)}{c.to === "chat" ? " · to Minami" : ""} </span>{c.text}</li>))}</ul>}
            <span className="flex flex-wrap items-center gap-2">
              {att.chat && <Link href={`/?open=${att.chat}`} className="text-[12.5px] hover:text-white" style={{ color: K.accentBright }}>Open Minami's chat →</Link>}
              <span className="ml-auto flex flex-wrap items-center gap-1.5">
                <span className="text-[11.5px]" style={{ color: K.faint }}>Resolve:</span>
                {reasons.map((r) => (
                  <button key={r} disabled={!!busy} onClick={() => resolve(r)} className="rounded-full px-2.5 py-0.5 text-[12px] hover:text-white"
                    style={{ background: "rgba(255,255,255,.06)", color: K.muted }}>{busy === r ? "…" : r}</button>
                ))}
              </span>
            </span>
            {err && <span className="block text-[12.5px]" style={{ color: "#ff8a8d" }}>{err}</span>}
          </span>
        )}
      </span>
    </li>
  );
}

/** What got resolved, newest first — the Today "Decisions" fold for flags. AUTO rows carry the evidence. */
export function AttentionFold({ items, render, onChanged }: { items: AttnView[]; render: (a: AttnView) => { tag?: React.ReactNode; title: React.ReactNode }; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const auto = items.filter((a) => a.resolved?.by === "auto").length;
  return (
    <div className="mt-3">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[.06em]" style={{ ...MONO, color: K.faint }}>
        <span className="transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>›</span>
        Resolved · {items.length}{auto ? ` (${auto} auto)` : ""}
      </button>
      {open && <ul className="mt-2 flex flex-col gap-2">{items.map((a) => {
        const r = a.resolved!, { tag, title } = render(a);
        return (
          <li key={a.key} className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-2.5 opacity-75">
            <span className="mt-0.5 flex h-[20px] w-[20px] items-center justify-center rounded-full text-[11px]" style={{ background: r.by === "auto" ? mix(AMBER, 22) : mix(GREEN, 22), color: r.by === "auto" ? AMBER : GREEN }}>✓</span>
            <span className="min-w-0">
              <span className="flex min-w-0 items-baseline gap-x-2">{tag}<span className="min-w-0 flex-1 truncate text-[14px] line-through" style={{ textDecorationColor: K.line2 }}>{title}</span>
                {r.by === "you" && <button onClick={async () => { await post({ op: "reopen", key: a.key }); onChanged(); }} className="shrink-0 text-[12px] hover:text-white" style={{ color: K.faint }}>Reopen</button>}
              </span>
              <span className="block text-[12.5px] leading-snug" style={{ color: K.muted }}>
                <span style={{ ...MONO, fontSize: 11, color: r.by === "auto" ? AMBER : GREEN }}>{r.by === "auto" ? "AUTO" : "YOU"}</span>
                {" · "}{when(r.at)}{r.how ? ` · ${r.how}` : ""}{r.evidence ? ` · ${r.evidence}` : ""}{r.note ? ` · “${r.note}”` : ""}
              </span>
            </span>
          </li>
        );
      })}</ul>}
    </div>
  );
}
