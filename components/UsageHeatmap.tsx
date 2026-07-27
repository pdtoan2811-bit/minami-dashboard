"use client";

import { useEffect, useMemo, useState } from "react";

const METRICS_URL = (process.env.NEXT_PUBLIC_METRICS_URL || "").replace(/\/$/, "");
const METRICS_KEY = process.env.NEXT_PUBLIC_METRICS_KEY || "";
const RANGES = [7, 14, 30, 60];
const COLORS = ["rgba(255,255,255,0.05)", "#e8859b3d", "#e8859b70", "#e8859bab", "#e8859b"];
const WEEKDAYS = ["", "Mon", "", "Wed", "", "Fri", ""];

type Day = { date: string; turns: number; tokens: number; cost: number };
const short = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

export function UsageHeatmap() {
  const [range, setRange] = useState(14);
  const [days, setDays] = useState<Day[]>([]);

  useEffect(() => {
    if (!METRICS_URL) return;
    const tz = new Date().getTimezoneOffset();
    const k = METRICS_KEY ? `&k=${encodeURIComponent(METRICS_KEY)}` : "";
    fetch(`${METRICS_URL}/timeseries?days=${range}&tz=${tz}${k}`)
      .then((r) => r.json()).then((d) => setDays(d.days || [])).catch(() => {});
  }, [range]);

  const { weeks, max, totalTok, totalTurns } = useMemo(() => {
    const max = Math.max(1, ...days.map((d) => d.tokens));
    const totalTok = days.reduce((a, d) => a + d.tokens, 0);
    const totalTurns = days.reduce((a, d) => a + d.turns, 0);
    const cells: (Day | null)[] = [];
    if (days.length) {
      const pad = new Date(days[0].date + "T00:00:00").getDay(); // 0=Sun
      for (let i = 0; i < pad; i++) cells.push(null);
    }
    cells.push(...days);
    const weeks: (Day | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return { weeks, max, totalTok, totalTurns };
  }, [days]);

  const level = (t: number) => (t === 0 ? 0 : t < max * 0.15 ? 1 : t < max * 0.4 ? 2 : t < max * 0.7 ? 3 : 4);

  if (!METRICS_URL) return <p className="text-sm text-neutral-400">No metrics source connected. Set <code className="text-xs">NEXT_PUBLIC_METRICS_URL</code>.</p>;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-black/10 p-0.5 dark:border-white/10">
          {RANGES.map((r) => (
            <button key={r} onClick={() => setRange(r)} className={`rounded-md px-2 py-0.5 text-[11px] transition-all ${range === r ? "bg-[--sakura] text-white" : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"}`} style={{ ["--sakura" as string]: "#e8859b" }}>{r}d</button>
          ))}
        </div>
        <span className="text-[11px] text-neutral-500">{short(totalTurns)} turns · {short(totalTok)} tok</span>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        <div className="flex shrink-0 flex-col gap-[3px] pt-0.5 text-[9px] text-neutral-500">
          {WEEKDAYS.map((d, i) => <div key={i} className="h-3 leading-3">{d}</div>)}
        </div>
        <div className="flex gap-[3px]">
          {weeks.map((w, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {Array.from({ length: 7 }).map((_, r) => {
                const d = w[r];
                return (
                  <div key={r} title={d ? `${d.date} · ${d.turns} turns · ${short(d.tokens)} tok · $${d.cost.toFixed(3)}` : ""}
                    className="h-3 w-3 rounded-[3px] transition-colors"
                    style={{ background: d ? COLORS[level(d.tokens)] : "transparent" }} />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-[10px] text-neutral-500">
        <span>less</span>
        {COLORS.map((c, i) => <span key={i} className="h-3 w-3 rounded-[3px]" style={{ background: c }} />)}
        <span>more</span>
        <span className="ml-auto">usage by day · your local time</span>
      </div>
    </div>
  );
}
