"use client";

// Desktop: every chat waiting on you, in one place, from any page state (§3, §26).
//
// The phone has had this since §23 (the inbox's "needs you" group). The desktop had nothing that
// gathered it: a question from a chat you weren't looking at showed only as a dot on some tile,
// somewhere on the board — and when nine Today hand-offs ran at once, six of them in one folder with
// one name, "a chat asked me something" became a search. This is the list.
//
// Fed by the board's own live-activity poll (no second request): what is shown here is exactly what
// the tiles and the push notifier see.

import { useEffect, useRef, useState } from "react";

export type Waiting = { sid: string; title: string; project: string; summary: string; kind: string; since?: number };

const KIND: Record<string, string> = { question: "asks", plan: "has a plan for you", permission: "wants approval", held: "is paused, waiting" };

function ago(ts?: number) {
  if (!ts) return "";
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

export function NeedsYouButton({ items, onOpen }: { items: Waiting[]; onOpen: (sid: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  // Nothing waiting → nothing shown. A permanent "0" would train the eye to skip the one control that
  // matters only when it isn't zero.
  useEffect(() => { if (!items.length) setOpen(false); }, [items.length]);
  if (!items.length) return null;

  const n = items.length;
  return (
    <div ref={box} className="relative">
      <button onClick={() => (n === 1 ? onOpen(items[0].sid) : setOpen(!open))}
        title={n === 1 ? `${items[0].title} — ${items[0].summary}` : `${n} chats are waiting on you`}
        className="flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-xs leading-none text-amber-200 hover:bg-amber-400/20">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
        {n === 1 ? "1 needs you" : `${n} need you`}
      </button>
      {open && (
        <div className="absolute right-0 top-8 w-[360px] overflow-hidden rounded-xl border border-white/10 bg-neutral-900/95 shadow-2xl backdrop-blur">
          <div className="border-b border-white/[0.06] px-3 py-2 text-[11px] uppercase tracking-wider text-neutral-500">Waiting on you · oldest first</div>
          <ul className="max-h-[60vh] overflow-y-auto">
            {items.map((w) => (
              <li key={w.sid}>
                <button onClick={() => { setOpen(false); onOpen(w.sid); }} className="flex w-full flex-col gap-0.5 px-3 py-2.5 text-left hover:bg-white/[0.05]">
                  <span className="flex items-center gap-2 text-[12.5px] text-neutral-200">
                    <span className="min-w-0 flex-1 truncate">{w.title}</span>
                    <span className="shrink-0 text-[10.5px] text-neutral-500">{ago(w.since)}</span>
                  </span>
                  <span className="truncate text-[11.5px] text-neutral-500">{w.project} {KIND[w.kind] ?? "needs you"}: <span className="text-neutral-400">{w.summary}</span></span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
