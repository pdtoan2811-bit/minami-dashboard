"use client";
// The Metrics board's usage section (§16) — what this Mac spends on Claude, from lib/usage-index.ts.
//
// Read top to bottom it answers, in order: how close am I to the limit right now; is this window heavier
// than the last; which model and which part of the box is spending it; WHY (context size — the lever the
// 2026-10-21 audit found, 55% of spend in calls already past 200k); and whether the routing change is
// holding (subagent runs by model, per day). Charts are hand-drawn SVG/HTML like the rest of the app —
// no chart dependency on the live box.
import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Bot, Boxes, CalendarClock, Gauge, Layers, ListOrdered, MonitorSmartphone, Workflow } from "lucide-react";
import type { UsageView, Family, LimitSample } from "@/lib/usage-index";

const FAM: { key: Family; label: string; color: string }[] = [
  { key: "opus", label: "Opus", color: "#7aa2ff" },
  { key: "sonnet", label: "Sonnet", color: "#f0b45a" },
  { key: "haiku", label: "Haiku", color: "#5fd0a0" },
  { key: "fable", label: "Fable", color: "#e98ab8" },
  { key: "other", label: "Other", color: "#8a8f98" },
];
// Context size is ordered, so one hue light → strong: the long-context bands are the ones to watch.
const BANDS = [
  { label: "< 100k", color: "rgba(122,162,255,0.22)" },
  { label: "100–200k", color: "rgba(122,162,255,0.42)" },
  { label: "200–400k", color: "rgba(122,162,255,0.68)" },
  { label: "400k +", color: "#7aa2ff" },
];
const WHERE = [
  { key: "main", label: "Main threads", color: "#7aa2ff" },
  { key: "sub", label: "Subagents", color: "#c9a3ff" },
];
// The day the routing change landed (subagents → Sonnet 5.5, Explore/scout → Haiku 5.5). Marked on the
// subagent chart so before/after is read off the picture, not remembered.
const ROUTING_DAY = "2026-10-21";

const usd = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString()}` : n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)}%` : "—");
const shortDay = (d: string) => { const [, m, dd] = d.split("-"); return `${Number(dd)}/${Number(m)}`; };
const weekday = (d: string) => new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" });

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5 text-[11px]">
      {options.map((o) => (
        <button key={String(o.v)} onClick={() => onChange(o.v)}
          className={`rounded-md px-2 py-0.5 transition-colors ${value === o.v ? "bg-white/10 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-400">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm" style={{ background: i.color }} />
          {i.label}{i.value && <span className="tabular-nums text-neutral-300">{i.value}</span>}
        </span>
      ))}
    </div>
  );
}

// ---- limits ------------------------------------------------------------------------------------------

function until(ts?: number) {
  if (!ts) return null;
  const m = Math.max(0, Math.round((ts - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function LimitBar({ label, value, reset, trail }: { label: string; value?: number; reset?: number; trail: number[] }) {
  const v = value ?? null;
  const tone = v == null ? "#8a8f98" : v >= 90 ? "#ff6b6b" : v >= 70 ? "#f0b45a" : "#7aa2ff";
  const max = Math.max(1, ...trail);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-neutral-400">{label}</span>
        <span className="text-[11px] text-neutral-500">{until(reset) ? `resets in ${until(reset)}` : ""}</span>
      </div>
      <div className="flex items-end gap-3">
        <span className="text-3xl font-semibold tabular-nums tracking-tight" style={{ color: v == null ? undefined : tone }}>{v == null ? "—" : `${Math.round(v)}%`}</span>
        {trail.length > 1 && (
          <svg viewBox={`0 0 ${trail.length - 1} 20`} preserveAspectRatio="none" className="mb-1.5 h-6 flex-1 overflow-visible">
            <polyline fill="none" stroke={tone} strokeOpacity={0.7} strokeWidth={1.5} vectorEffect="non-scaling-stroke"
              points={trail.map((t, i) => `${i},${20 - (20 * t) / Math.max(100, max)}`).join(" ")} />
          </svg>
        )}
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700" style={{ width: `${Math.min(100, v ?? 0)}%`, background: tone }} />
        {[50, 80].map((t) => <div key={t} className="absolute inset-y-0 w-px bg-white/20" style={{ left: `${t}%` }} />)}
      </div>
    </div>
  );
}

// ---- stacked daily bars ------------------------------------------------------------------------------

type Series = { key: string; label: string; color: string };
function StackedDays({ days, series, value, marker, unit = "usd", height = 180 }: {
  days: string[]; series: Series[]; value: (dayIdx: number, key: string) => number; marker?: { day: string; label: string }; unit?: "usd" | "count"; height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const totals = days.map((_, i) => series.reduce((a, s) => a + value(i, s.key), 0));
  const max = Math.max(...totals, unit === "usd" ? 1 : 1);
  const nice = niceMax(max);
  const padL = 40, padB = 20, padT = 10, H = height, W = Math.max(w, 200);
  const bw = (W - padL) / Math.max(1, days.length);
  const y = (v: number) => padT + (H - padB - padT) * (1 - v / nice);
  const fmt = (v: number) => (unit === "usd" ? usd(v) : String(Math.round(v)));
  const mIdx = marker ? days.indexOf(marker.day) : -1;
  const every = Math.ceil(days.length / Math.max(1, Math.floor((W - padL) / 44)));
  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      {w > 0 && (
        <svg width={W} height={H} className="block">
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <line x1={padL} x2={W} y1={y(nice * t)} y2={y(nice * t)} stroke="white" strokeOpacity={t === 0 ? 0.15 : 0.06} />
              <text x={padL - 6} y={y(nice * t) + 3} textAnchor="end" className="fill-neutral-500 text-[10px] tabular-nums">{fmt(nice * t)}</text>
            </g>
          ))}
          {days.map((d, i) => {
            let acc = 0;
            // Bars at ~60% of the slot, capped: an 8-day window otherwise draws slabs that read as area.
            const bwi = Math.max(1, Math.min(bw * 0.62, 44));
            const x = padL + i * bw + (bw - bwi) / 2;
            return (
              <g key={d} onMouseEnter={() => setHover(i)} opacity={hover == null || hover === i ? 1 : 0.45}>
                <rect x={padL + i * bw} y={0} width={bw} height={H - padB} fill="transparent" />
                {series.map((s) => {
                  const v = value(i, s.key); if (v <= 0) return null;
                  const y0 = y(acc), y1 = y(acc + v); acc += v;
                  return <rect key={s.key} x={x} y={y1} width={bwi} height={Math.max(0.5, y0 - y1)} fill={s.color} rx={bwi > 6 ? 1.5 : 0} />;
                })}
                {i % every === 0 && <text x={padL + i * bw + bw / 2} y={H - 5} textAnchor="middle" className="fill-neutral-500 text-[10px]">{shortDay(d)}</text>}
              </g>
            );
          })}
          {mIdx >= 0 && (
            <g>
              <line x1={padL + mIdx * bw} x2={padL + mIdx * bw} y1={0} y2={H - padB} stroke="#5fd0a0" strokeDasharray="3 3" />
              <text x={padL + mIdx * bw - 4} y={10} textAnchor="end" className="fill-[#5fd0a0] text-[10px]">{marker!.label}</text>
            </g>
          )}
        </svg>
      )}
      {hover != null && w > 0 && (
        <div className="pointer-events-none absolute top-0 z-10 min-w-[150px] rounded-lg border border-white/10 bg-neutral-900/95 px-2.5 py-2 text-[11px] shadow-lg"
          style={{ left: Math.min(W - 160, Math.max(0, padL + hover * bw + bw + 6)) }}>
          <div className="mb-1 font-medium text-neutral-200">{weekday(days[hover])} {shortDay(days[hover])} · {fmt(totals[hover])}</div>
          {series.map((s) => { const v = value(hover, s.key); return v > 0 && (
            <div key={s.key} className="flex items-center justify-between gap-3 text-neutral-400">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.label}</span>
              <span className="tabular-nums text-neutral-300">{fmt(v)}{unit === "usd" ? ` · ${pct(v, totals[hover])}` : ""}</span>
            </div>); })}
        </div>
      )}
    </div>
  );
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

// ---- heatmap -----------------------------------------------------------------------------------------

function Heat({ heat }: { heat: number[][] }) {
  const max = Math.max(0.01, ...heat.flat());
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const [tip, setTip] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: "28px repeat(24, minmax(0, 1fr))" }}>
        {heat.map((row, d) => (
          <div key={d} className="contents">
            <span className="self-center text-[10px] text-neutral-500">{days[d]}</span>
            {row.map((v, h) => (
              <div key={h} onMouseEnter={() => setTip(`${days[d]} ${String(h).padStart(2, "0")}:00 · ${usd(v)}`)} onMouseLeave={() => setTip(null)}
                className="aspect-square rounded-[3px]"
                style={{ background: v > 0 ? `rgba(122,162,255,${0.1 + 0.9 * Math.sqrt(v / max)})` : "rgba(255,255,255,0.035)" }} />
            ))}
          </div>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="text-center text-[9px] text-neutral-600">{h % 6 === 0 ? h : ""}</span>)}
      </div>
      <div className="h-4 text-[11px] text-neutral-400">{tip ?? "Hover a cell · darker = more spend that hour of the week"}</div>
    </div>
  );
}

// ---- ranked bars (HTML) ------------------------------------------------------------------------------

function Ranked({ rows, total, color = "#7aa2ff" }: { rows: { label: string; usd: number; note?: string; split?: number }[]; total: number; color?: string }) {
  const max = Math.max(0.01, ...rows.map((r) => r.usd));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate text-neutral-300">{r.label}</span>
            <span className="shrink-0 tabular-nums text-neutral-400">{usd(r.usd)} <span className="text-neutral-600">· {pct(r.usd, total)}</span></span>
          </div>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
            <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(100 * r.usd) / max}%`, background: color }} />
            {r.split != null && r.split > 0 && (
              <div className="absolute inset-y-0 rounded-r-full" style={{ left: `${(100 * (r.usd - r.split)) / max}%`, width: `${(100 * r.split) / max}%`, background: "#c9a3ff" }} />
            )}
          </div>
          {r.note && <span className="text-[10px] text-neutral-500">{r.note}</span>}
        </div>
      ))}
    </div>
  );
}

// ---- the board ---------------------------------------------------------------------------------------

function Kpi({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: number | null }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
      <span className="text-[11px] text-neutral-500">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold tabular-nums tracking-tight text-neutral-100">{value}</span>
        {delta != null && Number.isFinite(delta) && (Math.abs(delta) < 1
          ? <span className="rounded-full bg-white/10 px-1.5 py-px text-[10px] text-neutral-400">flat</span>
          : <span className={`rounded-full px-1.5 py-px text-[10px] tabular-nums ${delta > 0 ? "bg-[#f0b45a]/15 text-[#f0b45a]" : "bg-[#5fd0a0]/15 text-[#5fd0a0]"}`}>
              {delta > 0 ? "▲" : "▼"} {Math.abs(Math.round(delta))}%
            </span>)}
      </div>
      {sub && <span className="text-[11px] text-neutral-500">{sub}</span>}
    </div>
  );
}

export function UsageBoard() {
  const [days, setDays] = useState<7 | 14 | 28>(7);
  const [mode, setMode] = useState<"model" | "where" | "context">("model");
  const [data, setData] = useState<UsageView | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await fetch(`/api/usage?days=${days}`, { cache: "no-store" });
        const d: UsageView = await r.json();
        if (!alive) return;
        setData(d); setErr(null);
        timer = setTimeout(load, d.building ? 3000 : 60_000);
      } catch (e) { if (alive) { setErr(String(e)); timer = setTimeout(load, 15_000); } }
    };
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [days]);

  const d = data;
  const derived = useMemo(() => {
    if (!d) return null;
    const T = d.total.usd;
    const long = d.bandTotals[2] + d.bandTotals[3];
    const sub = d.daily.reduce((a, x) => a + x.sub, 0);
    const runs = d.subRuns.reduce((a, r) => { for (const f of FAM) a[f.key] += r.fam[f.key]; return a; }, { opus: 0, sonnet: 0, haiku: 0, fable: 0, other: 0 } as Record<Family, number>);
    const runTotal = Object.values(runs).reduce((a, b) => a + b, 0);
    const delta = d.prevTotal.usd > 0 ? (100 * (T - d.prevTotal.usd)) / d.prevTotal.usd : null;
    const cacheHit = d.total.cr / Math.max(1, d.total.cr + d.total.tin + d.total.cw);
    return { T, long, sub, runs, runTotal, delta, cacheHit };
  }, [d]);

  const last = d?.limits.at(-1) as LimitSample | undefined;
  const trail7 = (d?.limits || []).map((s) => s.seven ?? 0);
  const trail5 = (d?.limits || []).slice(-36).map((s) => s.five ?? 0);
  const dayKeys = d?.daily.map((x) => x.day) || [];

  return (
    <section className="mb-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h2 className="text-sm font-semibold tracking-tight text-neutral-200">Claude usage · this Mac</h2>
          <p className="text-[11px] text-neutral-500">
            Every transcript on this machine: dashboard panes, terminal, desktop app, Minami bot. Priced at list rates as a yardstick. You're on a subscription, so this isn't a bill.
            {d && d.builtAt > 0 && ` Updated ${new Date(d.builtAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`}
          </p>
        </div>
        <Seg value={days} onChange={setDays} options={[{ v: 7, label: "7 days" }, { v: 14, label: "14 days" }, { v: 28, label: "28 days" }]} />
      </div>

      {d?.building && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-neutral-400">
          Indexing transcripts for the first time: {d.progress.done} of {d.progress.total} files. This takes about a minute once; after that only new lines are read.
        </div>
      )}
      {err && !d && <div className="text-xs text-[#ff6b6b]">Couldn't load usage: {err}</div>}

      {d && derived && (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            <Card>
              <CardHeader><Gauge className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>Plan limits{last?.email ? ` · ${last.email}` : ""}</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-5">
                <LimitBar label="5-hour window" value={last?.five} reset={last?.fiveReset} trail={trail5} />
                <LimitBar label="7-day, all models" value={last?.seven} reset={last?.sevenReset} trail={trail7} />
                <p className="text-[11px] leading-relaxed text-neutral-500">
                  {last ? `Sampled from token-slayer every 10 minutes, last at ${new Date(last.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. The line is the history since sampling began.`
                    : "No limit sample yet. The first one is taken within a minute of opening this page (it needs `tok` on PATH)."}
                </p>
              </CardContent>
            </Card>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Kpi label={`Usage · last ${days} days`} value={usd(derived.T)} delta={derived.delta} sub={`vs ${usd(d.prevTotal.usd)} the ${days} days before`} />
              <Kpi label="Calls" value={d.total.calls.toLocaleString()} sub={`${usd(derived.T / Math.max(1, d.total.calls))} per call`} />
              <Kpi label="On Opus" value={pct(d.famTotals.opus, derived.T)} sub={`Sonnet ${pct(d.famTotals.sonnet, derived.T)} · Haiku ${pct(d.famTotals.haiku, derived.T)}`} />
              <Kpi label="In calls past 200k context" value={pct(derived.long, derived.T)} sub="Long chats re-read on every call" />
              <Kpi label="Subagents" value={pct(derived.sub, derived.T)} sub={`${derived.runTotal} runs · ${pct(derived.runs.sonnet + derived.runs.haiku, derived.runTotal)} on Sonnet or Haiku`} />
              <Kpi label="Read from cache" value={`${Math.round(100 * derived.cacheHit)}%`} sub={`Output ${(d.total.tout / 1e6).toFixed(1)}M tokens`} />
            </div>
          </div>

          <Card>
            <CardHeader className="flex-wrap">
              <Activity className="h-4 w-4 text-[var(--sakura)]" /><CardTitle className="flex-1">Usage per day</CardTitle>
              <Seg value={mode} onChange={setMode} options={[{ v: "model", label: "By model" }, { v: "where", label: "Main vs subagent" }, { v: "context", label: "By context size" }]} />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {mode === "model" && <>
                <StackedDays days={dayKeys} series={FAM.filter((f) => d.famTotals[f.key] > 0)} value={(i, k) => d.daily[i].fam[k as Family]} />
                <Legend items={FAM.filter((f) => d.famTotals[f.key] > 0).map((f) => ({ ...f, value: pct(d.famTotals[f.key], derived.T) }))} />
              </>}
              {mode === "where" && <>
                <StackedDays days={dayKeys} series={WHERE} value={(i, k) => (k === "main" ? d.daily[i].main : d.daily[i].sub)} />
                <Legend items={WHERE.map((s) => ({ ...s, value: pct(s.key === "sub" ? derived.sub : derived.T - derived.sub, derived.T) }))} />
              </>}
              {mode === "context" && <>
                <StackedDays days={dayKeys} series={BANDS.map((b, i) => ({ key: String(i), ...b }))} value={(i, k) => d.daily[i].band[Number(k)]} />
                <Legend items={BANDS.map((b, i) => ({ ...b, value: pct(d.bandTotals[i], derived.T) }))} />
                <p className="text-[11px] text-neutral-500">How much context each call carried. Main chats compact at 300k. Opus advice in Build mode switches off past 120k.</p>
              </>}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><Workflow className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>Subagent runs by model</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-3">
                <StackedDays days={dayKeys} unit="count" height={150} series={FAM.filter((f) => derived.runs[f.key] > 0)}
                  value={(i, k) => d.subRuns[i]?.fam[k as Family] || 0} marker={dayKeys.includes(ROUTING_DAY) ? { day: ROUTING_DAY, label: "routing → Sonnet/Haiku" } : undefined} />
                <Legend items={FAM.filter((f) => derived.runs[f.key] > 0).map((f) => ({ ...f, value: String(derived.runs[f.key]) }))} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CalendarClock className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>When it's spent</CardTitle></CardHeader>
              <CardContent><Heat heat={d.heat} /></CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader><MonitorSmartphone className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>Where it runs</CardTitle></CardHeader>
              <CardContent>
                <Ranked total={derived.T} rows={d.entries.map((e) => ({ label: e.label, usd: e.usd, note: `${e.calls.toLocaleString()} calls` }))} />
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader><Boxes className="h-4 w-4 text-[var(--sakura)]" /><CardTitle className="flex-1">Projects</CardTitle>
                <Legend items={[{ label: "main", color: "#7aa2ff" }, { label: "subagents", color: "#c9a3ff" }]} />
              </CardHeader>
              <CardContent>
                <Ranked total={derived.T} rows={d.projects.map((p) => ({ label: p.name, usd: p.usd, split: p.sub }))} />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><Bot className="h-4 w-4 text-[var(--sakura)]" /><CardTitle className="flex-1">Automations · headless runs</CardTitle>
              <Legend items={FAM.filter((f) => d.automations.some((a) => (a.fam[f.key] || 0) > 0)).map((f) => ({ label: f.label, color: f.color }))} />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {d.automations.length > 0 ? (
                <div className="flex flex-col divide-y divide-white/[0.06]">
                  {d.automations.map((a) => {
                    const fams = FAM.filter((f) => (a.fam[f.key] || 0) > 0);
                    return (
                      <div key={a.source} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-2 sm:grid-cols-[minmax(0,1fr)_140px_70px_70px_64px]">
                        <span className="truncate text-xs text-neutral-200">{a.source}</span>
                        <div className="hidden h-1.5 overflow-hidden rounded-full bg-white/[0.05] sm:flex">
                          {fams.map((f) => <div key={f.key} style={{ width: `${(100 * (a.fam[f.key] || 0)) / Math.max(0.0001, a.usd)}%`, background: f.color }} />)}
                        </div>
                        <span className="hidden text-right text-[11px] tabular-nums text-neutral-400 sm:block">{a.runs} {a.runs === 1 ? "run" : "runs"}</span>
                        <span className="hidden text-right text-[11px] tabular-nums text-neutral-400 sm:block">{a.hours * 60 < 1 ? `${Math.round(a.hours * 3600)}s` : a.hours < 1 ? `${Math.round(a.hours * 60)}m` : `${a.hours.toFixed(1)}h`}</span>
                        <span className="text-right text-xs font-medium tabular-nums text-neutral-200">{usd(a.usd)}</span>
                      </div>
                    );
                  })}
                </div>
              ) : <span className="text-xs text-neutral-500">No logged headless runs in this window yet.</span>}
              <p className="text-[11px] leading-relaxed text-neutral-500">
                Scheduled and scripted Claude runs that keep no transcript: the nightly video jobs, the daily pitch, the toolshed helper (today-sync, goals, Minami ideas), today-research. Each run logs what Claude reported it used.
                {d.ledgerSince ? ` Logging began ${new Date(d.ledgerSince).toLocaleDateString(undefined, { month: "short", day: "numeric" })}; runs before that aren't in any total on this page.` : " Nothing logged yet."}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><ListOrdered className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>Heaviest sessions</CardTitle></CardHeader>
            <CardContent className="flex flex-col divide-y divide-white/[0.06]">
              {d.sessions.map((s) => {
                const fams = FAM.filter((f) => (s.fam[f.key] || 0) > 0);
                return (
                  <a key={s.sid} href={s.href} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-2 sm:grid-cols-[minmax(0,1fr)_120px_70px_70px_64px]">
                    <div className="min-w-0">
                      <div className="truncate text-xs text-neutral-200 group-hover:text-white">{s.title || s.sid.slice(0, 8)}</div>
                      <div className="text-[10px] text-neutral-500">{s.proj} · {new Date(s.last).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
                    </div>
                    <div className="hidden h-1.5 overflow-hidden rounded-full bg-white/[0.05] sm:flex" title={fams.map((f) => `${f.label} ${usd(s.fam[f.key]!)}`).join(" · ")}>
                      {fams.map((f) => <div key={f.key} style={{ width: `${(100 * (s.fam[f.key] || 0)) / Math.max(0.01, s.usd)}%`, background: f.color }} />)}
                    </div>
                    <span className="hidden text-right text-[11px] tabular-nums text-neutral-400 sm:block">{s.calls.toLocaleString()} calls</span>
                    <span className="hidden text-right text-[11px] tabular-nums text-neutral-400 sm:block">{Math.round(s.peak / 1000)}k peak</span>
                    <span className="text-right text-xs font-medium tabular-nums text-neutral-200">{usd(s.usd)}</span>
                  </a>
                );
              })}
              {d.sessions.length === 0 && <span className="py-2 text-xs text-neutral-500">No sessions in this window yet.</span>}
            </CardContent>
          </Card>

          <p className="flex items-center gap-1.5 text-[11px] text-neutral-600">
            <Layers className="h-3 w-3" /> Transcripts cover chats and anything that saves a session. Headless runs come from <code>~/.minami/headless-usage.jsonl</code>. A new headless spawner has to log there, or this page won't see it.
          </p>
        </>
      )}
    </section>
  );
}
