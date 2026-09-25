"use client";

// The per-ask progress bar + ETA — one component for the bento tile and the pane's status line, so the
// two can't disagree about how far along an ask is. All of the arithmetic is in lib/task-progress.ts;
// this only draws it.
//
// It ticks itself (1s) rather than taking a clock from its parent, for the same reason TurnClock in
// app/page.tsx does: the tile grid is framer-motion, and a parent re-render per second to move a 2px
// bar would re-render the whole board. The poll hands it fixed timestamps; the fill moves locally.

import { useEffect, useState } from "react";
import { etaPhrase, fmtShort, fractionAt, type TaskProgress } from "@/lib/task-progress";

export function TaskProgressBar({ p, compact }: { p: TaskProgress; compact?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => { const h = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(h); }, []);
  const now = Date.now();
  const pct = Math.round(fractionAt(p, now) * 100);
  const eta = etaPhrase(p, now);
  const over = !!p.etaAt && now > p.etaAt + 15_000;

  const title = [
    `${p.done} of ${p.total} planned steps done`,
    p.now && `now: ${p.now}`,
    p.paceMs && `pace ~${fmtShort(p.paceMs)} per step, ${p.paceFrom === "this" ? "measured on this request" : "from earlier requests in this session — none of this one's steps has finished yet"}`,
    !p.paceMs && "no ETA yet — it appears once a step finishes",
    "The bar counts plan items Claude wrote; the step in flight earns partial credit by time, never a full step.",
  ].filter(Boolean).join("\n");

  return (
    <span className={`flex min-w-0 items-center ${compact ? "gap-1.5 text-[9px]" : "gap-2 text-[10px]"} text-neutral-500`} title={title}>
      <span className={`shrink-0 overflow-hidden rounded-full bg-white/10 ${compact ? "h-1 w-14" : "h-1.5 w-24"}`}>
        {/* width transition only — no pulse or shimmer: this sits inside tiles, where an always-running
            animation is a measured GPU cost (docs/knowledge/12-rendering-cost.md). */}
        <span className="block h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%`, background: over ? "#e0a94a" : "#1f8a5c" }} />
      </span>
      <span className="shrink-0 tabular-nums text-neutral-400">{p.done}/{p.total}</span>
      {eta && <span className={`shrink-0 tabular-nums ${over ? "text-[#e0a94a]" : ""}`}>· {eta}</span>}
      {p.now && <span className="min-w-0 truncate italic text-neutral-500">· {p.now}</span>}
    </span>
  );
}
