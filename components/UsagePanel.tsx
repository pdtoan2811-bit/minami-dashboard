"use client";

import { useEffect, useState } from "react";
import { eventCost } from "@/lib/routing";
import { sourceMeta } from "@/lib/sources";

const METRICS_URL = (process.env.NEXT_PUBLIC_METRICS_URL || "").replace(/\/$/, "");
const METRICS_KEY = process.env.NEXT_PUBLIC_METRICS_KEY || "";

type SourceStat = { source: string; events: number; inTok: number; outTok: number; cost: number; lastTs: number };
type Stats = {
  totals: { events: number; inTok: number; outTok: number; cost: number };
  bySource: SourceStat[];
  updated: number;
};

const costOf = (e: { model?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }) =>
  eventCost(e.inputTokens, e.outputTokens, e.cacheReadTokens, e.model);
const short = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

export function UsagePanel() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [live, setLive] = useState(false);
  const q = METRICS_KEY ? `?k=${encodeURIComponent(METRICS_KEY)}` : "";

  useEffect(() => {
    if (!METRICS_URL) return;
    let cancelled = false;
    let es: EventSource | null = null;

    fetch(METRICS_URL + "/stats" + q)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setStats(d); })
      .catch(() => {});

    try {
      es = new EventSource(METRICS_URL + "/stream" + q);
      es.onopen = () => setLive(true);
      es.onerror = () => setLive(false);
      es.onmessage = (ev) => {
        let e: { hello?: boolean; source?: string; model?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; ts?: number };
        try { e = JSON.parse(ev.data); } catch { return; }
        if (e.hello) return;
        setStats((prev) => {
          const base: Stats = prev || { totals: { events: 0, inTok: 0, outTok: 0, cost: 0 }, bySource: [], updated: 0 };
          const c = costOf(e);
          const bySource = base.bySource.map((s) => ({ ...s }));
          let s = bySource.find((x) => x.source === e.source);
          if (!s) { s = { source: e.source || "unknown", events: 0, inTok: 0, outTok: 0, cost: 0, lastTs: 0 }; bySource.push(s); }
          s.events++; s.inTok += e.inputTokens || 0; s.outTok += e.outputTokens || 0; s.cost += c; s.lastTs = e.ts || Date.now();
          bySource.sort((a, b) => b.cost - a.cost);
          return {
            totals: {
              events: base.totals.events + 1,
              inTok: base.totals.inTok + (e.inputTokens || 0),
              outTok: base.totals.outTok + (e.outputTokens || 0),
              cost: base.totals.cost + c,
            },
            bySource,
            updated: Date.now(),
          };
        });
      };
    } catch { /* SSE unsupported */ }

    return () => { cancelled = true; es?.close(); };
  }, [q]);

  if (!METRICS_URL) {
    return (
      <p className="text-sm text-neutral-400">
        No metrics source connected. Set <code className="text-xs">NEXT_PUBLIC_METRICS_URL</code> to your
        metrics API URL to see live usage across your machines.
      </p>
    );
  }

  const t = stats?.totals;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <Metric label="Turns" value={t ? String(t.events) : "—"} />
        <Metric label="Tokens" value={t ? short(t.inTok + t.outTok) : "—"} />
        <Metric label="Cost" value={t ? `$${t.cost.toFixed(3)}` : "—"} accent />
      </div>

      <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
        <span className={`h-1.5 w-1.5 rounded-full ${live ? "animate-pulse bg-green-500" : "bg-neutral-300"}`} />
        {live ? "live · all machines" : "connecting…"}
      </div>

      <div className="flex flex-col gap-2">
        {(stats?.bySource || []).map((s) => {
          const m = sourceMeta(s.source);
          return (
            <div key={s.source} className="rounded-lg border border-black/5 p-2 dark:border-white/10">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <span className="h-2 w-2 rounded-full" style={{ background: m.tint }} />
                  {m.label}
                </span>
                <span className="text-xs tabular-nums text-neutral-400">${s.cost.toFixed(3)}</span>
              </div>
              <div className="mt-1 flex gap-3 text-[10px] text-neutral-400">
                <span>{s.events} turns</span>
                <span>{short(s.inTok)} in</span>
                <span>{short(s.outTok)} out</span>
              </div>
            </div>
          );
        })}
        {stats && stats.bySource.length === 0 && (
          <p className="text-xs text-neutral-400">Connected — waiting for the first turn from any machine…</p>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-black/5 py-2 dark:border-white/10">
      <span className="text-[10px] text-neutral-500">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${accent ? "text-[var(--sakura)]" : ""}`}>{value}</span>
    </div>
  );
}
