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
const TASKS = [
  { key: "chats", label: "Chats started", color: "#7aa2ff" },
  { key: "subagents", label: "Subagent runs", color: "#c9a3ff" },
  { key: "headless", label: "Headless runs", color: "#5fd0a0" },
];
const WHERE = [
  { key: "main", label: "Main threads", color: "#7aa2ff" },
  { key: "sub", label: "Subagents", color: "#c9a3ff" },
];
// The day the routing change landed (subagents → Sonnet 5.5, Explore/scout → Haiku 5.5). Marked on the
// subagent chart so before/after is read off the picture, not remembered.
const ROUTING_DAY = "2026-10-21";

const usd = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString()}` : n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
/** tokens, short: 1.2B · 340M · 12k */
const tok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
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

const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * One limit window as a race against its reset (Thomas, 2026-10-23: the old sparkline was "so hard to see the changes
 * without proper size + legend like time … I want to visualize how usage are racing with time till reset + predict how
 * it will be at the end"). Time runs left → right from the window's start to its reset, on a straight strip with a
 * now-line (his rule: time is a straight line, not a dial). Three lines: what's USED, the EVEN PACE diagonal (0% at
 * the start to 100% at the reset — above it means ahead of the clock), and the FORECAST from now to the reset at the
 * recent rate. The sentence on top says what the picture says.
 */
function LimitRace({ label, samples, pick, reset, windowMs, rateMs, ticks }: {
  label: string; samples: LimitSample[]; pick: (s: LimitSample) => number | undefined; reset?: number;
  windowMs: number; rateMs: number; ticks: "hours" | "days";
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const now = Date.now();
  const last = samples.at(-1), v = last ? pick(last) ?? null : null;
  const tone = v == null ? "#8a8f98" : v >= 90 ? "#ff6b6b" : v >= 70 ? "#f0b45a" : "#7aa2ff";
  if (!reset || v == null) return (
    <div className="flex flex-col gap-1"><span className="text-xs text-neutral-400">{label}</span>
      <span className="text-3xl font-semibold tabular-nums" style={{ color: v == null ? undefined : tone }}>{v == null ? "—" : `${Math.round(v)}%`}</span></div>
  );
  const start = reset - windowMs, span = reset - start;
  // This window only: a sample from before the start belongs to the previous window (a reset drops the value).
  const pts = samples.filter((s) => s.ts >= start && s.ts <= now && pick(s) != null).map((s) => ({ t: s.ts, v: pick(s)! }));
  // The recent rate (per ms) over the last `rateMs` — but only when the samples really cover that much. With less (sampling
  // only runs while a dashboard is open, and a failover starts a new account's history), a busy afternoon would be carried
  // through the nights: the first version said the 7-day window "hits 100% Sat 11:56" from five daytime hours. Then the
  // window's own average is the honest rate: what's used so far over the time gone.
  const recent = pts.filter((p) => p.t >= now - rateMs);
  const covered = recent.length >= 2 && recent.at(-1)!.t - recent[0].t >= rateMs * 0.75;
  const rate = covered ? Math.max(0, (recent.at(-1)!.v - recent[0].v) / (recent.at(-1)!.t - recent[0].t)) : v / Math.max(1, now - start);
  const atReset = v + rate * (reset - now);
  const full = rate > 0 && atReset >= 100 ? now + (100 - v) / rate : null;
  const even = (100 * (now - start)) / span;

  const H = 120, padL = 30, padR = 10, padT = 8, padB = 18, W = Math.max(w, 220);
  const x = (t: number) => padL + ((Math.min(Math.max(t, start), reset) - start) / span) * (W - padL - padR);
  const y = (p: number) => padT + (H - padT - padB) * (1 - Math.min(100, Math.max(0, p)) / 100);
  const tickTs: number[] = [];
  if (ticks === "hours") { const d = new Date(start); d.setMinutes(0, 0, 0); for (let t = d.getTime() + 3_600_000; t < reset; t += 3_600_000) tickTs.push(t); }
  else { const d = new Date(start); d.setHours(0, 0, 0, 0); for (let t = d.getTime() + 864e5; t < reset; t += 864e5) tickTs.push(t); }
  const used = [...pts, { t: now, v }];
  const fEnd = full ?? reset, fVal = full ? 100 : atReset;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-neutral-400">{label}</span>
        <span className="text-[11px] tabular-nums text-neutral-500">resets {ticks === "days" ? new Date(reset).toLocaleDateString(undefined, { weekday: "short" }) + " " : ""}{hm(reset)} · in {until(reset)}</span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-3xl font-semibold tabular-nums tracking-tight" style={{ color: tone }}>{Math.round(v)}%</span>
        <span className="text-[12px] leading-snug" style={{ color: full ? "#ff6b6b" : atReset >= 80 ? "#f0b45a" : "#a3a3a3" }}>
          {full ? <>at this pace it <b>hits 100% at {hm(full)}</b>, {until(now + reset - full)} before the reset</>
            : <>at this pace <b className="text-neutral-200">~{Math.round(atReset)}%</b> at the reset</>}
          <span className="text-neutral-500"> · {v >= even ? `${Math.round(v - even)} pts ahead of even pace` : `${Math.round(even - v)} pts under even pace`}</span>
        </span>
      </div>
      <div ref={ref}>
        {w > 0 && (
          <svg width={W} height={H} className="block overflow-visible">
            {[0, 50, 100].map((p) => (
              <g key={p}>
                <line x1={padL} x2={W - padR} y1={y(p)} y2={y(p)} stroke={p === 100 ? "#ff6b6b" : "white"} strokeOpacity={p === 100 ? 0.35 : p === 0 ? 0.15 : 0.06} />
                <text x={padL - 5} y={y(p) + 3} textAnchor="end" className="fill-neutral-500 text-[10px] tabular-nums">{p}%</text>
              </g>
            ))}
            {tickTs.map((t) => (
              <text key={t} x={x(t)} y={H - 4} textAnchor="middle" className="fill-neutral-500 text-[10px] tabular-nums">
                {ticks === "hours" ? hm(t) : new Date(t).toLocaleDateString(undefined, { weekday: "short" })}
              </text>
            ))}
            <line x1={x(start)} y1={y(0)} x2={x(reset)} y2={y(100)} stroke="white" strokeOpacity={0.28} strokeDasharray="2 4" />
            <path d={`M${x(used[0].t)},${y(0)} ` + used.map((p) => `L${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ") + ` L${x(now)},${y(0)} Z`} fill={tone} fillOpacity={0.12} />
            <polyline fill="none" stroke={tone} strokeWidth={2} strokeLinejoin="round" points={used.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")} />
            <line x1={x(now)} y1={y(v)} x2={x(fEnd)} y2={y(fVal)} stroke={full ? "#ff6b6b" : tone} strokeWidth={1.75} strokeDasharray="1 4" strokeLinecap="round" />
            {full && <circle cx={x(full)} cy={y(100)} r={3} fill="#ff6b6b" />}
            {!full && <text x={x(reset) - 2} y={y(atReset) - 5} textAnchor="end" className="text-[10px] tabular-nums" fill={tone}>~{Math.round(atReset)}%</text>}
            <line x1={x(now)} x2={x(now)} y1={padT - 4} y2={H - padB} stroke="white" strokeOpacity={0.5} />
            <circle cx={x(now)} cy={y(v)} r={3} fill={tone} />
            <text x={x(now)} y={padT - 6} textAnchor={x(now) > W - 40 ? "end" : "middle"} className="fill-neutral-300 text-[10px]">now</text>
          </svg>
        )}
      </div>
    </div>
  );
}

// ---- stacked daily bars ------------------------------------------------------------------------------

type Series = { key: string; label: string; color: string };
function StackedDays({ days, series, value, marker, unit = "usd", height = 180 }: {
  days: string[]; series: Series[]; value: (dayIdx: number, key: string) => number; marker?: { day: string; label: string }; unit?: "usd" | "count" | "tok"; height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const totals = days.map((_, i) => series.reduce((a, s) => a + value(i, s.key), 0));
  const max = Math.max(...totals, unit === "usd" ? 1 : 1);
  const nice = niceMax(max);
  const padL = 40, padB = 20, padT = 10, H = height, W = Math.max(w, 200);
  const bw = (W - padL) / Math.max(1, days.length);
  const y = (v: number) => padT + (H - padB - padT) * (1 - v / nice);
  const fmt = (v: number) => (unit === "usd" ? usd(v) : unit === "tok" ? tok(v) : String(Math.round(v)));
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
              <span className="tabular-nums text-neutral-300">{fmt(v)}{unit !== "count" ? ` · ${pct(v, totals[hover])}` : ""}</span>
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

// One project per row: $ and share, tokens, calls, and the bar split by model (Thomas, 2026-10-23: "add tokens and
// models"). It used to split main vs subagent; that split is on the per-day chart's "Main vs subagent" view.
function ProjectRows({ rows, total }: { rows: UsageView["projects"]; total: number }) {
  const max = Math.max(0.01, ...rows.map((r) => r.usd));
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r) => {
        const fams = FAM.filter((f) => r.fam[f.key] > 0);
        return (
          <div key={r.name} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-neutral-300">{r.name}</span>
              <span className="shrink-0 tabular-nums text-neutral-400">{usd(r.usd)} <span className="text-neutral-600">· {pct(r.usd, total)}</span></span>
            </div>
            <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.05]" style={{ width: "100%" }}>
              <div className="flex h-full" style={{ width: `${(100 * r.usd) / max}%` }}>
                {fams.map((f) => <div key={f.key} title={`${f.label} ${usd(r.fam[f.key])}`} style={{ width: `${(100 * r.fam[f.key]) / Math.max(0.0001, r.usd)}%`, background: f.color }} />)}
              </div>
            </div>
            <span className="text-[10.5px] tabular-nums text-neutral-500">
              {tok(r.tok)} tokens · {r.calls.toLocaleString()} calls · {fams.map((f) => `${f.label} ${pct(r.fam[f.key], r.usd)}`).join(" · ")}
              {r.sub > 0 ? ` · subagents ${pct(r.sub, r.usd)}` : ""}
            </span>
          </div>
        );
      })}
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
  // Tokens by default (Thomas, 2026-10-23: "default by number of tokens, add tokens + number of tasks too").
  const [unit, setUnit] = useState<"tok" | "usd" | "tasks">("tok");
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
  // The active account's samples only: a failover to another account mid-window would read as a jump.
  const acct = (d?.limits || []).filter((s) => !last?.email || s.email === last.email);
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
                <LimitRace label="5-hour window" samples={acct} pick={(s) => s.five} reset={last?.fiveReset} windowMs={5 * 3_600_000} rateMs={60 * 60_000} ticks="hours" />
                <LimitRace label="7-day, all models" samples={acct} pick={(s) => s.seven} reset={last?.sevenReset} windowMs={7 * 864e5} rateMs={24 * 3_600_000} ticks="days" />
                <Legend items={[{ label: "Used", color: "#7aa2ff" }, { label: "Even pace (0% → 100% by the reset)", color: "rgba(255,255,255,.35)" }, { label: "Forecast at the recent rate", color: "rgba(122,162,255,.55)" }]} />
                <p className="text-[11px] leading-relaxed text-neutral-500">
                  {last ? `Sampled from token-slayer every 10 minutes, last at ${new Date(last.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Forecast: the last hour's rate (5-hour window) or the last day's (7-day), carried to the reset; the window's average while there's less history than that.`
                    : "No limit sample yet. The first one is taken within a minute of opening this page (it needs `tok` on PATH)."}
                </p>
              </CardContent>
            </Card>
            <div className="grid grid-cols-2 content-start gap-3 md:grid-cols-3">
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
              <Seg value={unit} onChange={setUnit} options={[{ v: "tok", label: "Tokens" }, { v: "usd", label: "$" }, { v: "tasks", label: "Tasks" }]} />
              {unit !== "tasks" && <Seg value={mode} onChange={setMode} options={[{ v: "model", label: "By model" }, { v: "where", label: "Main vs subagent" }, { v: "context", label: "By context size" }]} />}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {unit === "tasks" ? <>
                <StackedDays days={dayKeys} unit="count" series={TASKS} value={(i, k) => d.daily[i].tasks[k as keyof typeof d.daily[number]["tasks"]]} />
                <Legend items={TASKS.map((t) => ({ ...t, value: String(d.daily.reduce((a, x) => a + x.tasks[t.key as keyof typeof x.tasks], 0)) }))} />
                <p className="text-[11px] text-neutral-500">Chats count on the day they started. Subagent runs are Task/Agent spawns inside them; headless runs are the scheduled jobs that log to the ledger{d.ledgerSince ? `, counted from ${new Date(d.ledgerSince).toLocaleDateString(undefined, { day: "numeric", month: "short" })} when logging began` : ""}.</p>
              </> : (() => {
                const get = (i: number) => (unit === "tok" ? d.daily[i].tok : d.daily[i]);
                const sum = (f: (x: UsageView["daily"][number]["tok"]) => number) => d.daily.reduce((a, x) => a + f(unit === "tok" ? x.tok : x), 0);
                const all = sum((x) => x.main + x.sub);
                return <>
                  {mode === "model" && <>
                    <StackedDays days={dayKeys} unit={unit} series={FAM.filter((f) => d.famTotals[f.key] > 0)} value={(i, k) => get(i).fam[k as Family]} />
                    <Legend items={FAM.filter((f) => d.famTotals[f.key] > 0).map((f) => ({ ...f, value: pct(sum((x) => x.fam[f.key]), all) }))} />
                  </>}
                  {mode === "where" && <>
                    <StackedDays days={dayKeys} unit={unit} series={WHERE} value={(i, k) => (k === "main" ? get(i).main : get(i).sub)} />
                    <Legend items={WHERE.map((w) => ({ ...w, value: pct(sum((x) => (w.key === "sub" ? x.sub : x.main)), all) }))} />
                  </>}
                  {mode === "context" && <>
                    <StackedDays days={dayKeys} unit={unit} series={BANDS.map((b, i) => ({ key: String(i), ...b }))} value={(i, k) => get(i).band[Number(k)]} />
                    <Legend items={BANDS.map((b, i) => ({ ...b, value: pct(sum((x) => x.band[i]), all) }))} />
                    <p className="text-[11px] text-neutral-500">How much context each call carried. Main chats compact at 300k. Opus advice in Build mode switches off past 120k.</p>
                  </>}
                  {unit === "tok" && <p className="text-[11px] text-neutral-500">Tokens are everything a call moved: input, output, cache writes and cache reads. Cache reads are most of it and the cheapest, which is why tokens and $ don't move together.</p>}
                </>;
              })()}
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
                <Legend items={FAM.filter((f) => d.projects.some((p) => p.fam[f.key] > 0)).map((f) => ({ label: f.label, color: f.color }))} />
              </CardHeader>
              <CardContent>
                <ProjectRows total={derived.T} rows={d.projects} />
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
