"use client";
// The Autopilot text inputs (§31), shaped like Today's "Add a to-do": type, Enter, done — no button to find
// first. Thomas, 2026-10-22, about the "Chat here" button: "do the text input like in today todo list".
// Like Today's boxes it keeps the typed text until the send lands: a failed POST must not eat it.
import { useState } from "react";
import { useOpenChat } from "@/components/shell/Drawer";
import { K, mix } from "../today/ui";

/** POST `body` + the typed text, then open the chat it started. `field` names the text's key in the body. */
export function AskBox({ placeholder, url, body, field, row }: {
  placeholder: string; url: string; body: Record<string, unknown>; field: string;
  /** a row inside a card (Today's AddTodo look) instead of a free-standing pill (Today's NoteBox look) */
  row?: boolean;
}) {
  const openChat = useOpenChat();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, [field]: v }) }).then((r) => r.json());
      if (r.error) setErr(r.error); else { setText(""); openChat(r.sessionId); }
    } catch { setErr("Couldn't reach the dashboard."); }
    finally { setBusy(false); }
  };
  const input = (
    <input value={text} onChange={(e) => setText(e.target.value.slice(0, 500))} placeholder={busy ? "Starting a chat…" : placeholder} disabled={busy}
      className={row ? "min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-white/35 disabled:opacity-60"
        : "h-11 w-full rounded-full px-5 text-[14.5px] outline-none placeholder:text-white/35 disabled:opacity-60"}
      style={row ? undefined : { background: mix(K.paper, 80), border: `1px solid ${K.line2}` }} />
  );
  return (
    <form onSubmit={send}>
      {row ? (
        <div className="flex items-center gap-3.5 rounded-xl px-4 py-2.5" style={{ background: "rgba(0,0,0,.22)", border: `1px solid ${K.line}` }}>
          <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[12px]" style={{ border: `1.5px dashed ${K.line2}`, color: K.faint }}>↵</span>
          {input}
        </div>
      ) : input}
      {err && <p className="mt-1.5 px-2 text-[12.5px]" style={{ color: "#ff8a8d" }}>{err}</p>}
    </form>
  );
}
