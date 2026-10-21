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
import type { ReactNode } from "react";
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
    const series: Score["series"] = [];
    for (let d = start; d <= today; d = addDays(d, 1)) series.push(at(d) ? at(d)!.rank : undefined);
    // At least a week wide, so the first reading sits on the right, at today, instead of alone at the left edge.
    while (series.length < 7) series.unshift(undefined);
    return { key: kw, label: `“${kw}”`, color: kwColor(i), now, day, first: rows.length <= 1,
      dayBefore: day ? at(addDays(day, -1)) : undefined, weekBefore: day ? at(addDays(day, -7)) : undefined, series };
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
 *  the floor; undefined (no reading) leaves a gap rather than a point. */
export function RankLine({ series, color, w = 240, h = 56 }: { series: (number | null | undefined)[]; color: string; w?: number; h?: number }) {
  const n = Math.max(2, series.length), x = (i: number) => 4 + (i / (n - 1)) * (w - 8);
  const y = (r: number | null) => (r == null ? h - 4 : 4 + (Math.log(r) / Math.log(100)) * (h - 14));
  const pts = series.map((r, i) => (r === undefined ? null : ([x(i), y(r)] as const)));
  const drawn = pts.filter(Boolean) as (readonly [number, number])[];
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block" style={{ height: h, overflow: "visible" }} aria-hidden>
      <line x1="0" x2={w} y1={h - 4} y2={h - 4} stroke={tint(SC.red, 35)} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <line x1="0" x2={w} y1="4" y2="4" stroke={tint(SC.green, 35)} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      {drawn.length > 1 && <polyline points={drawn.map((p) => p.join(",")).join(" ")} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
      {pts.map((p, i) => p && <circle key={i} cx={p[0]} cy={p[1]} r={i === series.length - 1 ? 4.5 : 2.5} fill={color} />)}
    </svg>
  );
}
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
