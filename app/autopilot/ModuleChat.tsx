"use client";
// "Chat here" (§31): opens a chat whose cwd is a module's folder (lib/modules.ts), so the chat loads that
// module's own AGENTS.md and reads its data. Lives here until a second page has a module to open.
import { useState } from "react";
import { useOpenChat } from "@/components/shell/Drawer";
import { K } from "../today/ui";

export function ModuleChat({ id, label = "Chat here" }: { id: string; label?: string }) {
  const openChat = useOpenChat();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/modules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "chat", id }) }).then((r) => r.json());
      if (r.error) setErr(r.error); else openChat(r.sessionId);
    } catch { setErr("Couldn't reach the dashboard."); }
    finally { setBusy(false); }
  };
  return (
    <span className="inline-flex items-center gap-2">
      {err && <span className="text-[12.5px]" style={{ color: "#ff8a8d" }}>{err}</span>}
      <button onClick={go} disabled={busy} title={`A new chat inside ~/.minami/${id}: it reads that module's rules and data`}
        className="h-8 rounded-full px-3.5 text-[13px] font-semibold disabled:opacity-50" style={{ background: "rgba(255,255,255,.07)", border: `1px solid ${K.line2}` }}>
        {busy ? "Starting…" : label}
      </button>
    </span>
  );
}
