"use client";
// The shell's + (§30): capture without leaving the page. Writes to the stores Minami already uses —
// an idea goes to the Ideas drop box (the bot's code tags it), a to-do onto today's plan, a goal into
// a vault chat that drafts its block (see POST /api/shell for why a goal can't be written directly).
import { useEffect, useRef, useState } from "react";
import { useBackLayer } from "@/lib/use-back";
import { K, mix, EASE, PillButton } from "@/app/today/ui";
import { refreshShell } from "./use-shell";
import { useOpenChat } from "./Drawer";

type Kind = "idea" | "todo" | "goal";
const KINDS: { v: Kind; label: string; hint: string }[] = [
  { v: "idea", label: "Idea", hint: "A link, a thought, a forward — lands in Ideas and gets tagged." },
  { v: "todo", label: "To-do", hint: "Added to today's plan." },
  { v: "goal", label: "Goal", hint: "Opens a chat in the vault that drafts the goal with you." },
];

export function Capture({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("idea");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const openChat = useOpenChat();
  useBackLayer(open, onClose);
  useEffect(() => { if (open) { setMsg(null); setTimeout(() => ta.current?.focus(), 60); } }, [open]);

  const save = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setMsg(null);
    try {
      let r: { error?: string; sessionId?: string };
      if (kind === "idea") {
        const f = new FormData(); f.append("text", t);
        r = await fetch("/api/ideas", { method: "POST", body: f }).then((x) => x.json());
      } else if (kind === "todo") {
        r = await fetch("/api/today", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "add", text: t }) }).then((x) => x.json());
      } else {
        r = await fetch("/api/shell", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "goal", text: t }) }).then((x) => x.json());
      }
      if (r.error) { setMsg(r.error); return; }
      setText(""); refreshShell(); onClose();
      if (kind === "goal" && r.sessionId) openChat(r.sessionId);
    } catch { setMsg("Couldn't save — check the connection."); }
    finally { setBusy(false); }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center md:items-start md:pt-[14vh]">
      <div onClick={onClose} className="absolute inset-0" style={{ background: "rgba(0,0,0,.5)" }} />
      <div role="dialog" aria-label="Capture" className="relative w-full max-w-[520px] p-5 max-md:rounded-t-[28px] max-md:pb-[max(1.25rem,env(safe-area-inset-bottom))] md:rounded-[28px]"
        style={{ background: `linear-gradient(160deg, ${mix(K.paper, 94)}, ${mix(K.bg, 96)})`, border: `1px solid ${K.line2}`, boxShadow: "0 24px 70px rgba(0,0,0,.55)", animation: `shell-rise 320ms ${EASE}` }}>
        <div className="mb-3 flex gap-1.5">
          {KINDS.map((k) => (
            <button key={k.v} onClick={() => setKind(k.v)} className="rounded-full px-3.5 py-1.5 text-[13.5px] font-semibold transition-colors"
              style={{ background: kind === k.v ? K.accent : mix(K.ink, 7), border: `1px solid ${kind === k.v ? "transparent" : K.line}` }}>{k.label}</button>
          ))}
        </div>
        <textarea ref={ta} value={text} onChange={(e) => setText(e.target.value)} rows={4}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); }}
          placeholder={kind === "idea" ? "Paste a link or write the thought…" : kind === "todo" ? "What needs doing today?" : "What should be true, and by when?"}
          className="w-full resize-none rounded-[18px] px-4 py-3 text-[15px] outline-none placeholder:text-white/35"
          style={{ background: mix(K.bg, 70), border: `1px solid ${K.line2}`, color: K.ink }} />
        <p className="mt-2 text-[12.5px]" style={{ color: msg ? "#ef7c7c" : K.faint }}>{msg ?? KINDS.find((k) => k.v === kind)!.hint}</p>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={onClose} className="px-2 text-[13px]" style={{ color: K.muted }}>Cancel</button>
          <span className="ml-auto hidden text-[11px] md:inline" style={{ color: K.faint, fontFamily: "var(--today-mono)" }}>⌘↵</span>
          <PillButton tone="accent" small disabled={!text.trim() || busy} onClick={save}>{busy ? "Saving…" : kind === "goal" ? "Draft it" : "Save"}</PillButton>
        </div>
      </div>
    </div>
  );
}
