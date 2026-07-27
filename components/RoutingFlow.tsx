"use client";

import { useEffect, useState } from "react";
import { MODELS, eventCost, opusEquivCost, tierFromModel } from "@/lib/routing";
import { sourceMeta } from "@/lib/sources";

const METRICS_URL = (process.env.NEXT_PUBLIC_METRICS_URL || "").replace(/\/$/, "");
const METRICS_KEY = process.env.NEXT_PUBLIC_METRICS_KEY || "";

type Ev = { id: number; source: string; label: string; tier: string; tint: string; cost: number; opus: number; tokIn: number; tokOut: number };
type TierAgg = { n: number; tok: number };
type State = {
  routed: number;
  opus: number;
  tokIn: number;
  tokOut: number;
  byTier: Record<string, TierAgg>;
  feed: Ev[];
};

const EMPTY: State = { routed: 0, opus: 0, tokIn: 0, tokOut: 0, byTier: {}, feed: [] };
const SRC = (s: string) => sourceMeta(s).short;
const SRC_TINT = (s: string) => sourceMeta(s).tint;
const short = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

let counter = 0;
function toEv(e: { source?: string; model?: string; label?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }): Ev {
  const m = tierFromModel(e.model);
  return {
    id: ++counter,
    source: e.source || "unknown",
    label: e.label || "",
    tier: m.tier,
    tint: m.tint,
    cost: eventCost(e.inputTokens, e.outputTokens, e.cacheReadTokens, e.model),
    opus: opusEquivCost(e.inputTokens, e.outputTokens, e.cacheReadTokens),
    tokIn: e.inputTokens || 0,
    tokOut: e.outputTokens || 0,
  };
}

export function RoutingFlow() {
  const [st, setSt] = useState<State>(EMPTY);
  const [live, setLive] = useState(false);
  const q = METRICS_KEY ? `?k=${encodeURIComponent(METRICS_KEY)}` : "";

  useEffect(() => {
    if (!METRICS_URL) return;
    let cancelled = false;
    let es: EventSource | null = null;

    fetch(METRICS_URL + "/stats" + q)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d?.totals) return;
        const byTier: Record<string, TierAgg> = {};
        for (const m of d.byModel || []) {
          const t = tierFromModel(m.model).tier;
          const b = byTier[t] || { n: 0, tok: 0 };
          b.n += m.events || 0;
          b.tok += m.tok || 0;
          byTier[t] = b;
        }
        setSt({
          routed: d.totals.cost || 0,
          opus: d.totals.opusCost ?? opusEquivCost(d.totals.inTok, d.totals.outTok, 0),
          tokIn: d.totals.inTok || 0,
          tokOut: d.totals.outTok || 0,
          byTier,
          feed: (d.recent || []).slice(0, 8).map(toEv),
        });
      })
      .catch(() => {});

    try {
      es = new EventSource(METRICS_URL + "/stream" + q);
      es.onopen = () => setLive(true);
      es.onerror = () => setLive(false);
      es.onmessage = (msg) => {
        let e: { hello?: boolean; source?: string; model?: string; label?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
        try { e = JSON.parse(msg.data); } catch { return; }
        if (e.hello) return;
        const ev = toEv(e);
        setSt((prev) => {
          const byTier = { ...prev.byTier };
          const b = byTier[ev.tier] ? { ...byTier[ev.tier] } : { n: 0, tok: 0 };
          b.n += 1;
          b.tok += ev.tokIn + ev.tokOut;
          byTier[ev.tier] = b;
          return {
            routed: prev.routed + ev.cost,
            opus: prev.opus + ev.opus,
            tokIn: prev.tokIn + ev.tokIn,
            tokOut: prev.tokOut + ev.tokOut,
            byTier,
            feed: [ev, ...prev.feed].slice(0, 8),
          };
        });
      };
    } catch { /* no SSE */ }

    return () => { cancelled = true; es?.close(); };
  }, [q]);

  if (!METRICS_URL) {
    return (
      <p className="text-sm text-neutral-400">
        No live stream. Set <code className="text-xs">NEXT_PUBLIC_METRICS_URL</code> to stream real turns
        routed across models from your machines.
      </p>
    );
  }

  const saved = st.opus > 0 ? (1 - st.routed / st.opus) * 100 : 0;
  const pct = st.opus > 0 ? Math.max(2, (st.routed / st.opus) * 100) : 100;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Metric label="Routed" value={`$${st.routed.toFixed(4)}`} />
        <Metric label="If all-Opus" value={`$${st.opus.toFixed(4)}`} />
        <Metric label="Tokens" value={short(st.tokIn + st.tokOut)} sub={`${short(st.tokIn)} in · ${short(st.tokOut)} out`} />
        <Metric label="Saved" value={`${saved.toFixed(0)}%`} accent />
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-white/10">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: "var(--sakura)" }} />
      </div>

      <div className="grid grid-cols-4 gap-2">
        {MODELS.map((m) => {
          const b = st.byTier[m.tier];
          return (
            <div key={m.tier} className="flex flex-col items-center rounded-xl border border-black/5 py-2 dark:border-white/10">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: m.tint }} />
              <span className="mt-1 text-[10px] font-medium">{m.tier.split(" ")[0]}</span>
              <span className="text-[11px] tabular-nums text-neutral-400">{b?.n ?? 0}</span>
              <span className="text-[9px] tabular-nums text-neutral-400">{short(b?.tok ?? 0)} tok</span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
        <span className={`h-1.5 w-1.5 rounded-full ${live ? "animate-pulse bg-green-500" : "bg-neutral-300"}`} />
        {live ? "live routing · real turns" : "connecting…"}
      </div>

      <div className="flex flex-col gap-1.5">
        {st.feed.map((e) => (
          <div
            key={e.id}
            className="animate-[slidein_.4s_ease] rounded-lg border-l-2 bg-neutral-100/60 py-1.5 pl-2.5 pr-2 dark:bg-white/5"
            style={{ borderColor: e.tint }}
          >
            <p className="line-clamp-2 text-xs leading-snug text-neutral-700 [overflow-wrap:anywhere] dark:text-neutral-200">
              {e.label || `${SRC(e.source)} turn`}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-neutral-400">
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: SRC_TINT(e.source) }} />
                {SRC(e.source)}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: e.tint }} />
                {e.tier.split(" ")[0]}
              </span>
              <span className="tabular-nums">{short(e.tokIn + e.tokOut)} tok</span>
              <span className="tabular-nums text-green-600 dark:text-green-400">
                {e.opus - e.cost > 1e-9 ? `saved $${(e.opus - e.cost).toFixed(4)}` : "no saving"}
              </span>
            </div>
          </div>
        ))}
        {st.feed.length === 0 && <p className="text-xs text-neutral-400">Waiting for the next turn from any machine…</p>}
      </div>
    </div>
  );
}

function Metric({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-black/5 py-2 dark:border-white/10">
      <span className="text-[10px] text-neutral-500">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${accent ? "text-[var(--sakura)]" : ""}`}>{value}</span>
      {sub && <span className="mt-0.5 text-[9px] tabular-nums text-neutral-400">{sub}</span>}
    </div>
  );
}
