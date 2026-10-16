"use client";
// A meeting's action items and decisions, each one tap away from Today or Ideas (§17 "links"). A call
// ends with "we should…" lines that used to stay on the board; this is how they leave it.
//
// Every item it creates points back at the meeting: a to-do carries `from` (Today renders it as a
// "from meeting: …" link — Today's text is plain words, so a link written into it wouldn't render),
// and an idea carries the meeting's absolute URL in its text, which the bot lifts into `links` like any
// other URL he sends it.
//
// Light, like the rest of /meetings: these pages sit beside the canvas that gets screen-shared.
//
// "Sent" is remembered in localStorage, not in the archive: the archive is the meeting's record (the
// tidy pass rewrites canvas.json, and a card id can change under it), and a duplicate send costs one
// extra to-do he can drop — not worth a second writer on that file.

import { useEffect, useState } from "react";

export type ActionCard = { id: string; kind: string; label: string; detail?: string };
type Where = "today" | "ideas";

const KEY = "minami.meetings.sent";
const readSent = (): Record<string, Where[]> => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };

export function SendTo({ meeting, card, compact }: { meeting: { id: string; title: string; date: string }; card: ActionCard; compact?: boolean }) {
  const k = `${meeting.id}:${card.id}`;
  const [sent, setSent] = useState<Where[]>([]);
  const [busy, setBusy] = useState<Where | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setSent(readSent()[k] ?? []); }, [k]);

  const mark = (w: Where) => {
    const all = readSent();
    all[k] = [...new Set([...(all[k] ?? []), w])];
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode: it just won't persist */ }
    setSent(all[k]);
  };

  const send = async (w: Where) => {
    if (busy) return;
    setBusy(w); setErr(null);
    const path = `/meetings/${encodeURIComponent(meeting.id)}`;
    const what = card.detail ? `${card.label}\n${card.detail}` : card.label;
    try {
      let r: { error?: string };
      if (w === "today") {
        r = await fetch("/api/today", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "add", text: what, from: { href: path, label: `meeting: ${meeting.title}`.slice(0, 80) } }),
        }).then((x) => x.json());
      } else {
        const form = new FormData();
        form.set("text", `${what}\n\nFrom the meeting “${meeting.title}” (${meeting.date}): ${location.origin}${path}`);
        r = await fetch("/api/ideas", { method: "POST", body: form }).then((x) => x.json());
      }
      if (r.error) setErr(r.error); else mark(w);
    } catch { setErr("couldn't reach Minami"); }
    setBusy(null);
  };

  const btn = "rounded-md border px-1.5 py-0.5 text-[11.5px] transition-colors disabled:opacity-40";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 ${compact ? "" : "ml-2"}`}>
      {(["today", "ideas"] as const).map((w) => sent.includes(w)
        ? <span key={w} className="px-1 text-[11.5px] text-emerald-700">✓ {w === "today" ? "Today" : "Ideas"}</span>
        : <button key={w} onClick={(e) => { e.preventDefault(); e.stopPropagation(); send(w); }} disabled={!!busy}
            className={`${btn} border-neutral-200 bg-white text-neutral-500 hover:border-neutral-400 hover:text-neutral-900`}>
            {busy === w ? "…" : `→ ${w === "today" ? "Today" : "Ideas"}`}</button>)}
      {err ? <span className="text-[11.5px] text-rose-600" title={err}>failed</span> : null}
    </span>
  );
}
