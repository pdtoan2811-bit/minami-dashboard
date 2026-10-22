"use client";
// Minami, docked on the right of /autopilot (desktop). Picked from the autopilot-layout pitch, V4 "Chat panel on the
// right" (2026-10-22), after "weird UX and readability on goals and runner": the chats used to sit as rows inside
// a 300 px column of the goal card, a reply read at ~35 characters a line, and the page had two ask boxes.
//
// Now every chat started on this tab — the message box below, "Resolve with Minami", "Fix it with Minami", "Add a
// goal" — is one thread in this panel: your question as a bubble, Minami's reply under it with its live word, the
// newest open in full. ONE box at the foot: it starts a new question, or, after "Reply" on a thread, writes into that
// chat. The page on the left keeps the width for numbers, to-dos and the runner table.
//
// The threads come from autopilot-asks.jsonl via the page's one AsksProvider (Asks.tsx); state is the server's.
import { useEffect, useRef, useState } from "react";
import { useOpenChat } from "@/components/shell/Drawer";
import Markdown from "@/components/Markdown";
import { K, mix, hhmm } from "../today/ui";
import { quickAnswerable, type LiveTile } from "../today/live";
import { CHAT_STATE, askLine, askState, pickAnswer, replyInto, useAsks, useFullReply, type Ask, type AskKind } from "./Asks";

/** How a new question is started from this tab: the route, its body, and the key the typed text goes under. */
export type Start = { url: string; body: Record<string, unknown>; field: string };

export function MinamiPanel({ about, scopes, start, placeholder }: {
  /** "about this goal" / "about your runners" — the header's small print */
  about: string;
  /** which asks are this tab's (kind + id; id "*" = every id of that kind) */
  scopes: { kind: AskKind; id: string }[];
  start: Start; placeholder: string;
}) {
  const { asks, live, reload } = useAsks();
  const mine = asks.filter((a) => scopes.some((s) => s.kind === a.kind && (s.id === "*" || s.id === a.id))).slice(-10);
  const [replyTo, setReplyTo] = useState<Ask | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const list = useRef<HTMLDivElement>(null);

  // Newest at the bottom, like a chat: land there when the panel opens and whenever a thread is added.
  const n = mine.length, last = mine.at(-1)?.sessionId;
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [n, last]);
  // A thread that left this tab's scope (tab switch) can't stay the reply target.
  useEffect(() => { if (replyTo && !mine.some((a) => a.sessionId === replyTo.sessionId)) setReplyTo(null); }, [mine, replyTo]);

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true); setErr("");
    if (replyTo) {
      const x = await replyInto(replyTo.sessionId, v);
      if (x) setErr(x); else { setText(""); reload(); }
    } else {
      try {
        const r = await fetch(start.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...start.body, [start.field]: v }) }).then((r) => r.json());
        if (r.error) setErr(r.error); else { setText(""); reload(); }
      } catch { setErr("Couldn't reach the dashboard."); }
    }
    setBusy(false);
  };

  return (
    // Tall enough to hold the message box on screen under the tabs at load; sticky, so it stays put as the page scrolls.
    <aside className="sticky top-4 flex h-[calc(100vh-150px)] min-h-[480px] flex-col overflow-hidden rounded-[20px]" style={{ background: "rgba(255,255,255,.035)", border: `1px solid ${K.line}` }}>
      <div className="flex items-center gap-2 px-5 pb-3 pt-4" style={{ borderBottom: `1px solid ${K.line}` }}>
        <span>🌸</span><b className="text-[15px]">Minami</b><span className="ml-auto text-[12.5px]" style={{ color: K.faint }}>{about}</span>
      </div>
      <div ref={list} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
        {!mine.length && <p className="m-auto max-w-[260px] text-center text-[14px] leading-relaxed" style={{ color: K.faint }}>Ask anything below. The chat stays here, and its reply lands under your question.</p>}
        {mine.map((a, i) => <Thread key={a.sessionId} a={a} tile={live[a.sessionId]} newest={i === mine.length - 1}
          replying={replyTo?.sessionId === a.sessionId} onReply={() => setReplyTo(a)} />)}
      </div>
      <form onSubmit={send} className="p-4" style={{ borderTop: `1px solid ${K.line}` }}>
        {replyTo && (
          <div className="mb-2 flex items-center gap-2 text-[12.5px]" style={{ color: K.accentBright }}>
            <span className="min-w-0 flex-1 truncate">Replying to: {replyTo.question}</span>
            <button type="button" onClick={() => setReplyTo(null)} style={{ color: K.faint }} aria-label="New question instead">✕</button>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-2xl px-3.5 py-2.5" style={{ background: "rgba(0,0,0,.25)", border: `1px solid ${K.line2}` }}>
          <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 4000))} rows={text.includes("\n") || text.length > 40 ? 3 : 1}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={busy ? "Sending…" : replyTo ? "Reply to Minami…" : placeholder} disabled={busy}
            className="min-w-0 flex-1 resize-none bg-transparent text-[14.5px] leading-snug outline-none placeholder:text-white/35 disabled:opacity-60" />
          {text.trim() && <button type="submit" disabled={busy} className="h-8 shrink-0 rounded-full px-3 text-[13px] font-semibold text-white disabled:opacity-50" style={{ background: K.accent }}>Send</button>}
        </div>
        {err && <p className="mt-1.5 text-[12.5px]" style={{ color: "#ff8a8d" }}>{err}</p>}
      </form>
    </aside>
  );
}

// One chat: the question on the right, the reply on the left. The newest is open in full; an older one shows its
// first line and opens on a tap.
function Thread({ a, tile, newest, replying, onReply }: { a: Ask; tile: LiveTile | undefined; newest: boolean; replying: boolean; onReply: () => void }) {
  const openChat = useOpenChat();
  const [open, setOpen] = useState(newest);
  useEffect(() => { if (newest) setOpen(true); }, [newest]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const st = askState(a, tile);
  const s = CHAT_STATE[st];
  const need = tile?.need;
  // Read for every thread, open or not: a closed one shows its reply's first line, and a chat that isn't live any more
  // (yesterday's, or after a restart) has no live text to show. One small read per thread (/api/glance/last).
  const reply = useFullReply(a.sessionId, true, st, tile);
  const line = askLine(st, tile) || reply?.text.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) || "";
  const pick = async (opt: string) => {
    if (!need) return;
    setBusy(true); setErr(await pickAnswer(a.sessionId, need.id, opt)); setBusy(false);
  };
  return (
    <div>
      <div className="ml-auto w-fit max-w-[88%] rounded-2xl rounded-br-md px-3.5 py-2 text-[14px] leading-snug text-white" style={{ background: K.accent }}>{a.question}</div>
      <div className="mt-2 max-w-[96%] rounded-2xl rounded-bl-md px-3.5 py-2.5 text-[14px] leading-relaxed" style={{ background: "rgba(255,255,255,.06)", outline: replying ? `1.5px solid ${K.accentBright}` : undefined }}>
        <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left">
          <span className={`rounded-full px-2 py-0.5 text-[10.5px] ${st === "running" ? "animate-pulse" : ""}`} style={{ background: mix(s.color, 18), color: s.color, fontFamily: "var(--today-mono)" }}>{s.dot} {s.label}</span>
          <span className="text-[11.5px]" style={{ color: K.faint, fontFamily: "var(--today-mono)" }}>{hhmm(a.at)}</span>
          <span className="ml-auto text-[12px] transition-transform" style={{ color: K.faint, transform: open ? "rotate(90deg)" : "none" }}>›</span>
        </button>
        {!open ? (line && <p className="mt-1.5 line-clamp-2" style={{ color: st === "needs" ? s.color : K.muted }}>{line}</p>) : (
          <div className="mt-2">
            {reply === null ? <p style={{ color: K.faint }}>Reading the chat…</p>
              : reply.text ? <div className="text-[14px]" style={{ color: K.muted }}><Markdown text={reply.text} /></div>
              : <p style={{ color: K.faint }}>{reply.failed ? "Couldn't read the chat — close and reopen to try again." : st === "running" ? "Minami is working — the reply lands here." : "No reply yet."}</p>}
            {need && (
              <div className="mt-2.5 rounded-xl px-3 py-2.5" style={{ background: mix("#ffd27a", 8), border: `1px solid ${mix("#ffd27a", 30)}` }}>
                <p className="whitespace-pre-line text-[13.5px] leading-snug" style={{ color: "#ffd27a" }}>{reply?.question || need.summary}</p>
                {quickAnswerable(need) && <div className="mt-2 flex flex-wrap gap-1.5">{need.options.map((o) => (
                  <button key={o} type="button" disabled={busy} onClick={() => pick(o)} className="rounded-full px-2.5 py-1 text-[13px] hover:brightness-125 disabled:opacity-50" style={{ background: "rgba(255,255,255,.07)", border: `1px solid ${K.line2}`, color: K.ink }}>{o}</button>
                ))}</div>}
              </div>
            )}
            <div className="mt-2.5 flex items-center gap-3 text-[12.5px]">
              <button type="button" onClick={onReply} style={{ color: replying ? K.accentBright : K.muted }}>{replying ? "Replying below ↓" : "Reply"}</button>
              {err && <span style={{ color: "#ff8a8d" }}>{err}</span>}
              <button type="button" onClick={() => openChat(a.sessionId)} className="ml-auto hover:text-white" style={{ color: K.faint }}>Open the full chat →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
