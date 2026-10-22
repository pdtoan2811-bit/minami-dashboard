"use client";

import { useEffect, useRef, useState } from "react";

// Where a team-ask card's "🤖 Để Minami trả lời" link lands (§25). The link is a GET, so it only names the
// card; the POST below is what starts the chat. The talk happens in a Slack thread, so this page doesn't
// pull you into the dashboard: it says where to look and offers the chat for the laptop. Opening the
// link again lands on the same chat — the server remembers it.
export default function MinamiAnswers() {
  const [msg, setMsg] = useState("Minami is reading the question…");
  const [err, setErr] = useState(false);
  const [sid, setSid] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return; // StrictMode runs effects twice in dev; the server dedupes too
    once.current = true;
    const q = new URLSearchParams(location.search);
    const body = q.get("ts") ? { ts: q.get("ts") } : { topic: q.get("topic") || "", asker: q.get("asker") || undefined };
    fetch("/api/team/minami", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok && d.sessionId) {
          setSid(d.sessionId);
          setMsg(d.fresh
            ? `Minami is reading ${d.asker}'s question. Its explanation lands in a Slack thread in the team-ask DM in a minute — reply there to ask anything, and say "trả lời đi" when you want it sent.`
            : "Minami is already on this one — the talk is in its Slack thread in the team-ask DM.");
        } else { setErr(true); setMsg(d?.error || "Couldn't start Minami."); }
      })
      .catch(() => { setErr(true); setMsg("Couldn't reach the dashboard."); });
  }, []);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-950 p-6 text-neutral-200">
      <div className="max-w-sm text-center">
        <div className="mb-3 text-3xl">🤖</div>
        <p className={err ? "text-amber-300" : "text-neutral-300"}>{msg}</p>
        {sid && (
          <div className="mt-5 flex justify-center gap-4 text-sm">
            <a href="slack://open" className="text-neutral-200 underline">Back to Slack</a>
            <a href={`/?open=${encodeURIComponent(sid)}`} className="text-neutral-400 underline">Open the chat here</a>
          </div>
        )}
        {err && <a href="/" className="mt-4 inline-block text-sm text-neutral-400 underline">Open the dashboard</a>}
      </div>
    </main>
  );
}
