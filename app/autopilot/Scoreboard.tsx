"use client";
// The goal as a scoreboard (§29) — the version Thomas picked from the autopilot pitch (V1 · Scoreboard, 2026-10-21),
// after two rounds he said didn't read ("not so intuitive"; "what the hell with the not in top 46???").
//
// What he asked for, and how it's answered:
//   • A rank is a NUMBER: "#55", or "100+" when it isn't in the 100 results the check read. Never "not in top N" —
//     the N is how deep the check read, and next to a rank it reads as one.
//   • Every number carries its change: ▲/▼ vs yesterday and vs 7 days ago. Lower rank = better, so ▲ is green.
//   • Shrink · Hide · Embody: one sentence, the numbers, the one thing that needs you. Every run, what it tried, the
//     learned rules and the raw ranks.jsonl lines are one click away, not on screen.
//
// The ranks come from ~/.minami/goals/<id>/ranks.jsonl (one line per keyword per day, written by the runner); the
// pages-in-Google count from log.jsonl, one point per day = that day's last run. Score cards come from the goal spec
// (one per target query, plus pages when the runner measures them), so a new goal gets its cards with no new code.
import { useState, type ReactNode } from "react";
import type { Goal, GoalRun, RankRow } from "@/lib/goals";
import { K } from "../today/ui";

export const SC = { green: "#4ade80", amber: "#f0a868", red: "#ef7c7c", blue: "#7aa2ff", violet: "#c4b5fd", grey: "rgba(255,255,255,.5)" };
const KW_COLORS = [SC.blue, SC.violet, "#7dd3fc", "#f9a8d4"];
export const kwColor = (i: number) => KW_COLORS[i % KW_COLORS.length];
const tint = (c: string, p: number) => `color-mix(in srgb, ${c} ${p}%, transparent)`;

/** "#55", or "100+" when the check read N results and we weren't in them (N+ for the shallow checks before 10-21). */
export const rankText = (r: RankRow | undefined) => (!r ? "—" : r.rank != null ? `#${r.rank}` : `${r.read >= 90 ? 100 : r.read}+`);

// ── days ────────────────────────────────────────────────────────────────────────────────────────────────
export const localDate = (d = new Date()) => d.toLocaleDateString("en-CA");
export const addDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() + n); return localDate(d); };
export const shortDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" });

export type Score = {
  key: string; label: string; color: string;
  /** The latest reading, and the day it is from (today, unless today's check hasn't run or failed). */
  now: RankRow | undefined; day: string | undefined;
  /** The same keyword a day and a week before `day`; undefined = no reading that day. */
  dayBefore: RankRow | undefined; weekBefore: RankRow | undefined;
  /** One point per day for the line, oldest first: a number, null (= not in the results read), undefined (no reading). */
  series: (number | null | undefined)[];
  /** The ranks.jsonl row behind each point of `series` (same index), for the hover readout. */
  rows: (RankRow | undefined)[];
  /** True when there has never been an earlier reading — the chips say "first reading" instead of a change. */
  first: boolean;
};

export function rankScores(g: Goal, days = 30): Score[] {
  const today = localDate();
  return (g.spec.target.queries ?? []).map((kw, i) => {
    const rows = g.ranks.filter((r) => r.keyword === kw).sort((a, b) => a.date.localeCompare(b.date));
    const at = (d: string) => rows.find((r) => r.date === d);
    const now = rows.at(-1), day = now?.date;
    const start = rows.length ? (rows[0].date > addDays(today, -(days - 1)) ? rows[0].date : addDays(today, -(days - 1))) : today;
    const series: Score["series"] = [], byDay: Score["rows"] = [];
    for (let d = start; d <= today; d = addDays(d, 1)) { const r = at(d); series.push(r ? r.rank : undefined); byDay.push(r); }
    // At least a week wide, so the first reading sits on the right, at today, instead of alone at the left edge.
    while (series.length < 7) { series.unshift(undefined); byDay.unshift(undefined); }
    return { key: kw, label: `“${kw}”`, color: kwColor(i), now, day, first: rows.length <= 1,
      dayBefore: day ? at(addDays(day, -1)) : undefined, weekBefore: day ? at(addDays(day, -7)) : undefined, series, rows: byDay };
  });
}

/** Pages in Google, one point per day (that day's last run). */
export function pageDays(g: Goal, n = 7): { date: string; indexed: number | null; total: number | null }[] {
  const by = new Map<string, { indexed: number; total: number }>();
  for (const r of g.log) if (r.index) by.set(new Date(r.at).toLocaleDateString("en-CA"), r.index);
  const today = localDate(), out = [];
  for (let i = n - 1; i >= 0; i--) { const d = addDays(today, -i), v = by.get(d); out.push({ date: d, indexed: v?.indexed ?? null, total: v?.total ?? null }); }
  return out;
}
export function pagesAt(g: Goal, date: string): number | null {
  const runs = g.log.filter((r) => r.index && new Date(r.at).toLocaleDateString("en-CA") === date);
  return runs.at(-1)?.index?.indexed ?? null;
}

/** The page's one sentence: each keyword's rank in words, from the same rows as the cards. */
export function headline(g: Goal): string {
  const s = rankScores(g);
  if (!s.length) return g.log.at(-1)?.decision.assessment.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? g.spec.goal;
  if (s.every((x) => !x.now)) return "No rank reading yet. The first one comes with the next 06:45 run.";
  return s.map((x) => !x.now ? `${x.label} has no reading yet.`
    : x.now.rank != null ? `${x.label} is #${x.now.rank} on Google.`
    : `${x.label} isn't in the top ${x.now.read >= 90 ? 100 : x.now.read} yet.`).join(" ");
}

// ── the parts ───────────────────────────────────────────────────────────────────────────────────────────
function Chip({ c, children }: { c: string; children: ReactNode }) {
  return <span className="inline-flex h-[26px] items-center whitespace-nowrap rounded-full px-2.5 text-[13px] font-semibold" style={{ color: c, background: tint(c, 14) }}>{children}</span>;
}
/** Rank change: a lower number is better, so moving from #38 to #34 is ▲ 4, green. null counts as 101. */
export function RankDelta({ from, to, label }: { from: RankRow | undefined; to: RankRow | undefined; label: string }) {
  if (!to) return null;
  if (!from) return <Chip c={SC.grey}>{label}: no reading</Chip>;
  if (from.rank == null && to.rank == null) return <Chip c={SC.grey}>{label}: same</Chip>;
  const v = (from.rank ?? 101) - (to.rank ?? 101), c = v > 0 ? SC.green : v < 0 ? SC.red : SC.grey;
  return <Chip c={c}>{label}: {v === 0 ? "same" : `${v > 0 ? "▲" : "▼"} ${Math.abs(v)}`}</Chip>;
}
export function CountDelta({ v, label }: { v: number | null; label: string }) {
  if (v == null) return <Chip c={SC.grey}>{label}: no reading</Chip>;
  const c = v > 0 ? SC.green : v < 0 ? SC.red : SC.grey;
  return <Chip c={c}>{label}: {v === 0 ? "same" : `${v > 0 ? "▲" : "▼"} ${Math.abs(v)}`}</Chip>;
}
export function ScoreDeltas({ s }: { s: Score }) {
  if (!s.now) return null;
  if (s.first) return <Chip c="#c9d6ff">first reading · {shortDay(s.now.date)}</Chip>;
  return <><RankDelta from={s.dayBefore} to={s.now} label="vs yesterday" /><RankDelta from={s.weekBefore} to={s.now} label="vs 7 days" /></>;
}

/** Rank by day, #1 at the top, log scale (the climb from #55 to #10 matters more than #95 to #55). null sits on
 *  the "100+" floor; undefined (no reading) leaves a gap, bridged by a faint dash so the eye doesn't read it as a drop.
 *  2026-10-29: Thomas called the unlabelled sparkline "ugly and confusing as hell" — two dashed red/green lines with no
 *  words, and nothing said that UP meant BETTER. So the axis now says #1 / #10 / 100+, the days are named, and the
 *  last point carries its number. The labels are HTML, not SVG text, because the SVG stretches to the width.
 *  2026-10-30: "from afar it looks the same" — on a fixed #1–100 log scale, #51 → #60 moved ~2 px. The scale now
 *  spans only the ranks in view (linear, padded, at least 8 ranks tall so #58 → #59 isn't a cliff); log only when the
 *  window crosses orders of magnitude (100+ → #2 → #1). The axis names the best and worst rank shown. Hover (or touch)
 *  a day for its reading: rank, change vs the reading before, Search Console's position, the URL Google ranked. */
export function RankLine({ series, rows, color, h = 56 }: { series: (number | null | undefined)[]; rows?: (RankRow | undefined)[]; color: string; w?: number; h?: number }) {
  const [hov, setHov] = useState<number | null>(null);
  const w = 240, n = Math.max(2, series.length), x = (i: number) => (i / (n - 1)) * w;
  const top = 8, floor = h - 8;
  const val = (r: number | null) => r ?? 101;
  const vals = series.filter((r) => r !== undefined).map((r) => val(r as number | null));
  const best = vals.length ? Math.min(...vals) : 1, worst = vals.length ? Math.max(...vals) : 101;
  const log = worst / best > 4;
  let lo = best, hi = worst;
  if (!log) { const pad = Math.max(1, (hi - lo) * 0.15), mid = (lo + hi) / 2, half = Math.max(4, (hi - lo) / 2 + pad); lo = Math.max(1, mid - half); hi = lo + 2 * half; }
  const f = (v: number) => (log ? Math.log(v) : v);
  const yr = (r: number | null) => (hi === lo ? (top + floor) / 2 : top + ((f(val(r)) - f(lo)) / (f(hi) - f(lo))) * (floor - top));
  const pct = (v: number) => `${(v / h) * 100}%`;
  const pts = series.map((r, i) => (r === undefined ? null : { i, x: x(i), y: yr(r), r }));
  const drawn = pts.filter(Boolean) as { i: number; x: number; y: number; r: number | null }[];
  const lastI = drawn.at(-1)?.i;
  // Solid between consecutive days, dashed across a missing day.
  const segs = drawn.slice(1).map((p, k) => ({ a: drawn[k], b: p, gap: p.i - drawn[k].i > 1 }));
  const lab = (v: number) => (v > 100 ? "100+" : `#${v}`);
  const ticks: [string, number][] = best === worst ? [[lab(best), yr(best)]] : [[lab(best), yr(best)], [lab(worst), yr(worst)]];
  const first = addDays(localDate(), -(series.length - 1));
  const hp = hov == null ? null : drawn.find((p) => p.i === hov) ?? null;
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawn.length) return;
    const b = e.currentTarget.getBoundingClientRect(), fx = ((e.clientX - b.left) / b.width) * w;
    setHov(drawn.reduce((m, p) => (Math.abs(p.x - fx) < Math.abs(m.x - fx) ? p : m)).i);
  };
  return (
    <div className="flex gap-2">
      <div className="relative w-8 shrink-0 text-[10.5px] tabular-nums" style={{ height: h, color: K.faint, fontFamily: "var(--today-mono)" }} aria-hidden>
        {ticks.map(([t, y]) => <span key={t} className="absolute right-0 -translate-y-1/2 leading-none" style={{ top: pct(y) }}>{t}</span>)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative cursor-crosshair" style={{ height: h }} onPointerMove={onMove} onPointerLeave={() => setHov(null)}>
          <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="absolute inset-0 block h-full w-full" style={{ overflow: "visible" }} aria-hidden>
            {ticks.map(([t, y]) => <line key={t} x1="0" x2={w} y1={y} y2={y} stroke="rgba(255,255,255,.08)" vectorEffect="non-scaling-stroke" />)}
            {/* A faint wash under the line, so the shape reads from across the room. */}
            {drawn.length > 1 && <path d={`M${drawn[0].x},${floor} ${drawn.map((p) => `L${p.x},${p.y}`).join(" ")} L${drawn.at(-1)!.x},${floor} Z`} fill={color} fillOpacity={0.1} />}
            {segs.map(({ a, b, gap }, k) => <line key={k} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeOpacity={gap ? 0.4 : 1} strokeWidth="2.5" strokeDasharray={gap ? "2 4" : undefined} vectorEffect="non-scaling-stroke" />)}
            {hp && <line x1={hp.x} x2={hp.x} y1={0} y2={h} stroke="rgba(255,255,255,.25)" vectorEffect="non-scaling-stroke" />}
          </svg>
          {/* Dots and the last value in HTML, so they stay round when the SVG stretches. */}
          {drawn.map((p) => {
            const big = p.i === lastI || p.i === hov;
            return <i key={p.i} className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${(p.x / w) * 100}%`, top: pct(p.y), width: big ? 9 : 5, height: big ? 9 : 5, background: color, boxShadow: p.i === hov ? "0 0 0 3px rgba(255,255,255,.25)" : undefined }} />;
          })}
          {drawn.length > 0 && hov == null && (() => { const p = drawn.at(-1)!; return (
            <span className="pointer-events-none absolute whitespace-nowrap text-[11px] font-semibold tabular-nums" style={{ right: 10, top: pct(p.y), color, transform: `translateY(${p.y < h / 2 ? "40%" : "-140%"})` }}>{p.r == null ? "100+" : `#${p.r}`}</span>
          ); })()}
          {hp && (() => { const pv = drawn[drawn.indexOf(hp) - 1]; return <RankTip p={hp} prev={pv} prevDate={pv && (rows?.[pv.i]?.date ?? addDays(first, pv.i))} row={rows?.[hp.i]} date={rows?.[hp.i]?.date ?? addDays(first, hp.i)} left={hp.x / w} color={color} />; })()}
        </div>
        <div className="mt-1 flex justify-between text-[10.5px]" style={{ color: K.faint, fontFamily: "var(--today-mono)" }} aria-hidden><span>{shortDay(first)}</span><span>today</span></div>
      </div>
    </div>
  );
}

/** The hover card on a rank line: one day's reading, as the runner wrote it to ranks.jsonl. */
function RankTip({ p, prev, prevDate, row, date, left, color }: { p: { r: number | null }; prev?: { r: number | null }; prevDate?: string; row?: RankRow; date: string; left: number; color: string }) {
  const d = prev ? (prev.r ?? 101) - (p.r ?? 101) : null;
  const path = row?.url ? row.url.replace(/^https?:\/\/[^/]+/, "") || "/" : null;
  return (
    <div className="pointer-events-none absolute bottom-full z-20 mb-2 min-w-[150px] whitespace-nowrap rounded-xl px-3 py-2 text-[12px] leading-[1.5] shadow-lg"
      style={{ background: "#0d0f13", border: `1px solid ${K.line}`, color: K.muted, left: `${left * 100}%`, transform: `translateX(${left > 0.6 ? "-100%" : left < 0.4 ? "0" : "-50%"})` }}>
      <div style={{ color: K.faint }}>{shortDay(date)}</div>
      <div className="text-[16px] font-semibold tabular-nums" style={{ color }}>{row ? rankText(row) : p.r == null ? "100+" : `#${p.r}`}</div>
      {d != null && <div className="tabular-nums" style={{ color: d > 0 ? SC.green : d < 0 ? SC.red : K.faint }}>{d > 0 ? `▲ ${d}` : d < 0 ? `▼ ${-d}` : "no change"} vs {prevDate ? shortDay(prevDate) : "before"}</div>}
      {row?.gsc_position != null && <div className="tabular-nums">Search Console: {row.gsc_position.toFixed(1)}</div>}
      {path && <div>Google ranked {path}</div>}
      {row && <div style={{ color: K.faint }}>read {row.read} results</div>}
    </div>
  );
}

/** The search itself, as the runner reads it (sensors.mjs serp(): US, English, no personalisation), opened at the
 *  results page where ecvision.ai sits — so a rank is one click from being checked by eye. */
export const serpUrl = (q: string, rank?: number | null) =>
  `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&gl=us&pws=0${rank && rank > 10 ? `&start=${Math.floor((rank - 1) / 10) * 10}` : ""}`;
export function PageBars({ days, h = 56 }: { days: { indexed: number | null; total: number | null }[]; h?: number }) {
  const top = Math.max(1, ...days.map((d) => d.total ?? d.indexed ?? 0));
  return (
    <div className="flex items-end gap-1" style={{ height: h }} aria-hidden>
      {days.map((d, i) => <i key={i} className="flex-1 rounded-[3px]" style={{ height: d.indexed == null ? 2 : `${Math.max(4, (d.indexed / top) * 100)}%`, background: d.indexed == null ? "rgba(255,255,255,.1)" : i === days.length - 1 ? SC.blue : tint(SC.blue, 45) }} />)}
    </div>
  );
}

/** "Day 7 of 28" as a straight bar — the goal's days, apart from anything to do with time of day. */
export function GoalDays({ g }: { g: Goal }) {
  const total = g.spec.started ? Math.max(1, Math.round((Date.parse(g.spec.deadline) - Date.parse(g.spec.started)) / 864e5)) : null;
  const used = total ? Math.min(total, Math.max(0, total - g.daysLeft)) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px]" style={{ color: K.muted }}>
      {total != null && used != null && <>day {used} of {total}<span className="relative h-2 w-[150px] overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,.1)" }}><i className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(used / total) * 100}%`, background: SC.amber }} /></span></>}
      <span>{g.daysLeft >= 0 ? `${g.daysLeft} days left` : `${-g.daysLeft} days past`} · {shortDay(g.spec.deadline)}</span>
    </span>
  );
}

export function ScoreCard({ k, color, value, deltas, children }: { k: string; color: string; value: ReactNode; deltas: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-[20px] p-5" style={{ background: "#14171d", border: `1px solid ${K.line}` }}>
      <div className="flex items-center gap-2 text-[15px]" style={{ color: K.muted }}><i className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: color }} /><span className="truncate">{k}</span></div>
      <div className="mb-2.5 mt-1.5 text-[48px] font-bold leading-none tracking-tight tabular-nums">{value}</div>
      <div className="flex min-h-[26px] flex-wrap gap-1.5">{deltas}</div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

/** The cards themselves, shared by the desktop board and its phone rows. */
export function useScoreCards(g: Goal) {
  const ranks = rankScores(g);
  const pd = pageDays(g), latest = [...pd].reverse().find((d) => d.indexed != null);
  const today = localDate();
  const pages = latest ? {
    value: latest.indexed!, total: latest.total,
    dayDelta: latest.indexed! - (pagesAt(g, addDays(latest.date, -1)) ?? NaN), weekDelta: latest.indexed! - (pagesAt(g, addDays(latest.date, -7)) ?? NaN),
    days: pd, stale: latest.date !== today ? latest.date : null,
  } : null;
  const fin = (v: number) => (Number.isFinite(v) ? v : null);
  return { ranks, pages: pages && { ...pages, dayDelta: fin(pages.dayDelta), weekDelta: fin(pages.weekDelta) } };
}

/** Every calendar day from the first run to today; a day's point is its LAST run, its spend the sum of its runs.
 *  (The phone's Indexed / Searches / Time screens draw from this; it outlived RankChart, which the cards replaced.) */
export type Day = { date: string; run: GoalRun | null; usd: number };
export function days(g: Goal): Day[] {
  if (!g.log.length) return [];
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-CA");
  const by = new Map<string, Day>();
  for (const r of g.log) {
    const d = day(r.at), cur = by.get(d);
    if (!cur || Date.parse(r.at) >= Date.parse(cur.run!.at)) by.set(d, { date: d, run: r, usd: (cur?.usd ?? 0) + (r.usd || 0) });
    else cur.usd += r.usd || 0;
  }
  const out: Day[] = [];
  const end = day(new Date().toISOString());
  for (let t = Date.parse(`${[...by.keys()].sort()[0]}T12:00:00`); ; t += 86400_000) {
    const d = day(new Date(t).toISOString());
    out.push(by.get(d) ?? { date: d, run: null, usd: 0 });
    if (d >= end || out.length > 60) break;
  }
  return out;
}
