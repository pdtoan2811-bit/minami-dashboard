"use client";
// Chats started from /autopilot, shown where they were started (2026-10-22). Thomas: "dont redirect me out of the
// view, I love the today todo list UX". Every box and button here used to end in router.push("/?open=…"), which
// threw him onto the home grid mid-thought, one decision split across two pages. Now a chat is a ROW on the card
// that started it, the way a handed-off to-do is a row on Today:
//   • one state word (working · needs you · replied · failed) and one line of what it said, without opening it;
//   • tap → the row opens in place: the whole reply, the answer buttons when the question is a single pick, and a
//     reply box that sends into the same chat;
//   • "Open chat →" is still there, but as the opt-in it is on Today, never the default.
// The link between a card and its chats is ~/.minami/autopilot-asks.jsonl (lib/autopilot-ask.ts); one poll serves
// the whole page, and the live state is the server's (/api/agent/live, REPLACE semantics), never derived here.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useOpenChat } from "@/components/shell/Drawer";
import Markdown from "@/components/Markdown";
import { K, mix, hhmm } from "../today/ui";
import { answerInPlace, quickAnswerable, stateOf, useHandoffLive, type HandoffState, type LiveTile } from "../today/live";

export type AskKind = "goal" | "runner" | "module";
export type Ask = { kind: AskKind; id: string; question: string; sessionId: string; at: string };

export const CHAT_STATE: Record<HandoffState, { label: string; color: string; dot: string }> = {
  needs: { label: "NEEDS YOU", color: "#ffd27a", dot: "●" },
  running: { label: "WORKING", color: K.accentBright, dot: "◌" },
  failed: { label: "FAILED", color: "#ff8a8d", dot: "✕" },
  finished: { label: "REPLIED", color: "#8fe0b8", dot: "✓" },
  gone: { label: "REPLIED", color: "#8fe0b8", dot: "✓" },
};

type Ctx = { asks: Ask[]; live: Record<string, LiveTile>; reload: () => void };
const AsksCtx = createContext<Ctx | null>(null);

/** Only the last day's chats are watched live: older rows keep their word from the transcript reader when opened. */
const LIVE_MS = 36 * 3600e3;

export function AsksProvider({ children }: { children: React.ReactNode }) {
  const [asks, setAsks] = useState<Ask[]>([]);
  const reload = useCallback(() => {
    fetch("/api/autopilot/ask", { cache: "no-store" }).then((r) => r.json()).then((j) => setAsks(j.asks ?? [])).catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);
  const recent = asks.filter((a) => Date.now() - Date.parse(a.at) < LIVE_MS).map((a) => a.sessionId);
  const live = useHandoffLive(recent);
  const v = useMemo(() => ({ asks, live, reload }), [asks, live, reload]);
  return <AsksCtx.Provider value={v}>{children}</AsksCtx.Provider>;
}

export function useAsks(): Ctx {
  return useContext(AsksCtx) ?? { asks: [], live: {}, reload: () => {} };
}

/** The chats started from one card or box, newest first. */
export function AskRows({ kind, id, max = 4, className = "" }: { kind: AskKind; id: string; max?: number; className?: string }) {
  const { asks, live } = useAsks();
  const mine = asks.filter((a) => a.kind === kind && a.id === id).slice(-max).reverse();
  if (!mine.length) return null;
  return (
    <ul className={`overflow-hidden rounded-xl ${className}`} style={{ background: "rgba(0,0,0,.22)", border: `1px solid ${K.line}` }}>
      {mine.map((a, i) => <AskRow key={a.sessionId} a={a} tile={live[a.sessionId]} watched={Date.now() - Date.parse(a.at) < LIVE_MS} first={i === 0} />)}
    </ul>
  );
}

function AskRow({ a, tile, watched, first }: { a: Ask; tile: LiveTile | undefined; watched: boolean; first: boolean }) {
  const openChat = useOpenChat();
  const { reload } = useAsks();
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState<{ text: string; question?: string; failed?: boolean } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // An unwatched (older) row has no live tile; "gone" would read as REPLIED, which is what it most likely is.
  // A chat a few seconds old may not be in the live feed's next answer yet: that is "starting", not "replied".
  const st = !watched ? "gone" : !tile && Date.now() - Date.parse(a.at) < 60_000 ? "running" : stateOf(tile);
  const s = CHAT_STATE[st];
  const need = tile?.need;
  const line = need?.summary || tile?.ended?.text?.split("\n").find((l) => l.trim()) || (st === "running" ? "Minami is on it…" : "");

  // The whole reply, read from the transcript when the row opens and again whenever the chat's state changes,
  // so an open row follows the chat without a reload. The feed's own text is cut at 400 chars.
  const endedAt = tile?.ended?.at;
  useEffect(() => {
    if (!open) return;
    let gone = false;
    fetch(`/api/glance/last?id=${encodeURIComponent(a.sessionId)}${need ? `&need=${encodeURIComponent(need.id)}` : ""}`, { cache: "no-store" })
      .then((r) => r.json()).then((j) => { if (!gone) setReply({ text: j.text || "", question: j.question }); })
      // Never leave "Reading the chat…" up forever: a dropped read says so, and reopening the row tries again.
      .catch(() => { if (!gone) setReply({ text: "", failed: true }); });
    return () => { gone = true; };
  }, [open, a.sessionId, st, endedAt, need?.id]);

  const send = async () => {
    const v = note.trim();
    if (!v || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/autopilot/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "reply", sessionId: a.sessionId, text: v }) }).then((r) => r.json());
      if (r.error) setErr(r.error); else { setNote(""); reload(); }
    } catch { setErr("Couldn't reach the dashboard."); }
    finally { setBusy(false); }
  };
  const pick = async (opt: string) => {
    if (!need) return;
    setBusy(true); setErr("");
    const r = await answerInPlace(a.sessionId, need.id, opt).catch(() => ({ ok: false, reason: "Couldn't reach the dashboard." }));
    if (!r.ok) setErr(r.reason || "Couldn't answer.");
    setBusy(false);
  };

  return (
    <li style={{ borderTop: first ? undefined : `1px solid ${K.line}` }}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-white/[0.03]">
        <span className="shrink-0 text-[12px]">💬</span>
        <span className="min-w-0 flex-1 truncate text-[14px]" style={{ color: K.ink }}>{a.question}</span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] ${st === "running" ? "animate-pulse" : ""}`}
          style={{ background: mix(s.color, 18), color: s.color, fontFamily: "var(--today-mono)" }}>{s.dot} {s.label}</span>
        <span className="shrink-0 text-[12px] transition-transform" style={{ color: K.faint, transform: open ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {/* The one line that says where it stands — visible without opening the row, as on Today. */}
      {line && !open && <p className="-mt-1.5 truncate pb-2.5 pl-[44px] pr-4 text-[12.5px]" style={{ color: st === "needs" ? s.color : K.faint }}>{line}</p>}
      {open && (
        <div className="flex flex-col gap-3 pb-4 pl-[44px] pr-4">
          <p className="text-[11.5px]" style={{ color: K.faint, fontFamily: "var(--today-mono)" }}>asked {hhmm(a.at)}</p>
          {reply === null ? <p className="text-[13px]" style={{ color: K.faint }}>Reading the chat…</p>
            : reply.text ? <div className="max-h-[420px] overflow-y-auto pr-1 text-[13.5px]"><Markdown text={reply.text} /></div>
            : <p className="text-[13px]" style={{ color: K.faint }}>{reply.failed ? "Couldn't read the chat — close and reopen the row to try again." : st === "running" ? "Minami is working — the reply lands here." : "No reply yet."}</p>}
          {need && (
            <div className="rounded-xl px-3.5 py-3" style={{ background: mix("#ffd27a", 8), border: `1px solid ${mix("#ffd27a", 30)}` }}>
              <p className="whitespace-pre-line text-[13.5px] leading-snug" style={{ color: "#ffd27a" }}>{reply?.question || need.summary}</p>
              {quickAnswerable(need) && (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {need.options.map((o) => (
                    <button key={o} disabled={busy} onClick={() => pick(o)} className="rounded-full px-3 py-1.5 text-[13px] disabled:opacity-50 hover:brightness-125"
                      style={{ background: "rgba(255,255,255,.07)", border: `1px solid ${K.line2}`, color: K.ink }}>{o}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={note.includes("\n") || note.length > 60 ? 3 : 1}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={need ? "Answer in your own words…" : "Reply to Minami…"}
            className="w-full resize-none rounded-2xl bg-transparent px-3.5 py-2.5 text-[13.5px] leading-snug outline-none placeholder:text-white/35"
            style={{ border: `1px solid ${K.line2}`, color: K.ink }} />
          <div className="flex flex-wrap items-center gap-3">
            {note.trim() && <button onClick={send} disabled={busy} className="h-8 rounded-full px-3.5 text-[13px] font-semibold text-white disabled:opacity-50" style={{ background: K.accent }}>{busy ? "Sending…" : "Send"}</button>}
            {err && <span className="text-[12.5px]" style={{ color: "#ff8a8d" }}>{err}</span>}
            {/* The opt-in, as on Today: the pane, for a plan to approve or a long thread. */}
            <button onClick={() => openChat(a.sessionId)} className="ml-auto text-[12.5px] hover:text-white" style={{ color: K.faint }}>Open the full chat →</button>
          </div>
        </div>
      )}
    </li>
  );
}
