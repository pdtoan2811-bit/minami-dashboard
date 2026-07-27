"use client";

import { useEffect, useRef, useState } from "react";
import { MODELS, OPUS_TIER, WORKLOAD, costUsd, tintOf, type Tier } from "@/lib/routing";

type Ev = { id: number; label: string; tier: Tier; tint: string; cost: number; opus: number };
type Totals = { routed: number; opus: number; byTier: Record<string, number> };

export function RoutingFlow() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [totals, setTotals] = useState<Totals>({ routed: 0, opus: 0, byTier: {} });
  const [live, setLive] = useState(false);
  const idRef = useRef(0);

  // Client-only: start empty (hydration-safe), then stream a sample workload through the router.
  useEffect(() => {
    setLive(true);
    const tick = () => {
      const w = WORKLOAD[Math.floor(Math.random() * WORKLOAD.length)];
      const cost = costUsd(w.in, w.out, w.tier);
      const opus = costUsd(w.in, w.out, OPUS_TIER);
      const ev: Ev = { id: ++idRef.current, label: w.label, tier: w.tier, tint: tintOf(w.tier), cost, opus };
      setEvents((prev) => [ev, ...prev].slice(0, 6));
      setTotals((prev) => ({
        routed: prev.routed + cost,
        opus: prev.opus + opus,
        byTier: { ...prev.byTier, [w.tier]: (prev.byTier[w.tier] ?? 0) + 1 },
      }));
    };
    tick();
    const iv = setInterval(tick, 1300);
    return () => clearInterval(iv);
  }, []);

  const saved = totals.opus > 0 ? (1 - totals.routed / totals.opus) * 100 : 0;
  const pct = totals.opus > 0 ? Math.max(2, (totals.routed / totals.opus) * 100) : 100;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <Metric label="Routed" value={`$${totals.routed.toFixed(4)}`} />
        <Metric label="If all-Opus" value={`$${totals.opus.toFixed(4)}`} />
        <Metric label="Saved" value={`${saved.toFixed(0)}%`} accent />
      </div>

      {/* routed cost as a slice of the all-Opus bill */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-white/10">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: "var(--sakura)" }}
        />
      </div>

      {/* tier lanes with live counts */}
      <div className="grid grid-cols-4 gap-2">
        {MODELS.map((m) => (
          <div key={m.tier} className="flex flex-col items-center rounded-xl border border-black/5 py-2 dark:border-white/10">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: m.tint }} />
            <span className="mt-1 text-[10px] font-medium">{m.tier.split(" ")[0]}</span>
            <span className="text-[11px] tabular-nums text-neutral-400">{totals.byTier[m.tier] ?? 0}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
        <span className={`h-1.5 w-1.5 rounded-full ${live ? "animate-pulse bg-green-500" : "bg-neutral-300"}`} />
        live routing · sample stream
      </div>

      <div className="flex flex-col gap-1">
        {events.map((e) => (
          <div
            key={e.id}
            className="flex animate-[slidein_.4s_ease] items-center justify-between gap-2 rounded-lg bg-neutral-100/60 px-2 py-1 text-xs dark:bg-white/5"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: e.tint }} />
              <span className="truncate">{e.label}</span>
            </span>
            <span className="shrink-0 text-[11px] text-neutral-400">
              {e.tier.split(" ")[0]} ·{" "}
              <span className="tabular-nums text-green-600 dark:text-green-400">
                −${(e.opus - e.cost).toFixed(4)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-black/5 py-2 dark:border-white/10">
      <span className="text-[10px] text-neutral-500">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${accent ? "text-[--sakura]" : ""}`}>{value}</span>
    </div>
  );
}
