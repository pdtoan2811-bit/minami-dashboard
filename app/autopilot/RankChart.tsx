"use client";
// A rank goal, day by day (§29) — shared by the desktop goal card and the phone's Rank screen.
//
// Asked for 2026-10-21: "goal is top 1, the actual is 46 of some sort" — the card said "Not in top 46" in a stat
// tile and a table, and 46 read as a rank. It is the DEPTH: how many results that morning's check read before
// giving up. So this chart never puts a "not found" on the rank axis. It has three lanes:
//   • the rank zone — #1 at the top, log scale (the SEO convention: #1→#3 is as big a move as #10→#30), bands for
//     top 3 / page 1 / pages 2–5, and the goal as a green line;
//   • "Not found" — the check worked and we weren't there; the dot says how deep it looked (">46");
//   • "Check failed" — a captcha or a timeout: no reading, never drawn as a result.
// The x axis runs from the first run to the DEADLINE, so the days still left are on screen as space, not a number.
// Every series is one query; a day's point is that day's last run (days()).
import { useEffect, useRef, useState } from "react";
import type { Goal, GoalRun, Position } from "@/lib/goals";

export type Day = { date: string; run: GoalRun | null; usd: number };
const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA");
const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" });

/** Every calendar day from the first run to today; a day's point is its LAST run, its spend the sum of its runs. */
export function days(g: Goal): Day[] {
  if (!g.log.length) return [];
  const by = new Map<string, Day>();
  for (const r of g.log) {
    const d = localDay(r.at), cur = by.get(d);
    if (!cur || Date.parse(r.at) >= Date.parse(cur.run!.at)) by.set(d, { date: d, run: r, usd: (cur?.usd ?? 0) + (r.usd || 0) });
    else cur.usd += r.usd || 0;
  }
  const out: Day[] = [];
  const end = localDay(new Date().toISOString());
  for (let t = Date.parse(`${[...by.keys()].sort()[0]}T12:00:00`); ; t += 86400_000) {
    const d = localDay(new Date(t).toISOString());
    out.push(by.get(d) ?? { date: d, run: null, usd: 0 });
    if (d >= end || out.length > 60) break;
  }
  return out;
}

/** Missing depth = page 1 only: depth is stored from 2026-10-19, and only on checks that succeeded. */
const depthOf = (r: GoalRun | null | undefined, q: string) => r?.depth?.[q] ?? 10;

/** The latest reading that IS a reading — a captcha morning doesn't erase what we last knew. */
function lastReal(g: Goal, q: string): { run: GoalRun; p: Exclude<Position, "no reading"> } | null {
  for (let i = g.log.length - 1; i >= 0; i--) {
    const p = g.log[i].positions[q];
    if (p !== undefined && p !== "no reading") return { run: g.log[i], p };
  }
  return null;
}

/** One sentence that says where the goal stands, in words — the line above the chart. */
export function rankSentence(g: Goal): string {
  const qs = g.spec.target.queries, goal = g.spec.target.value;
  const reads = qs.map((q) => ({ q, r: lastReal(g, q) }));
  const found = reads.filter((x) => typeof x.r?.p === "number") as { q: string; r: { run: GoalRun; p: number } }[];
  const by = `Goal: #${goal} by ${dayLabel(g.spec.deadline)}`;
  if (!reads.some((x) => x.r)) return `No working check yet: every check so far failed. ${by}.`;
  if (found.length) {
    const best = found.reduce((a, b) => (b.r.p < a.r.p ? b : a));
    const rest = qs.length > 1 ? ` (${reads.map((x) => `“${x.q}” ${typeof x.r?.p === "number" ? `#${x.r.p}` : x.r ? `not in top ${depthOf(x.r.run, x.q)}` : "no reading"}`).join(", ")})` : "";
    return `Best rank now #${best.r.p} for “${best.q}”${rest}. ${by}.`;
  }
  const depths = reads.map((x) => (x.r ? `${depthOf(x.r.run, x.q)} for “${x.q}”` : null)).filter(Boolean);
  return `Not on Google yet: the last check read the top ${depths.join(" and ")}, and ${siteOf(g)} wasn't in them. ${by}.`;
}
const siteOf = (g: Goal) => (g.spec.goal.match(/[a-z0-9-]+\.[a-z]{2,}/i)?.[0] ?? "the site");

const SERIES = ["#7aa2ff", "#c39bff", "#5fd4c8", "#f3c766"];
const GREEN = "#3ecf8e", RED = "#ff8a8d";

export function RankChart({ g, height = 260, compact = false }: { g: Goal; height?: number; compact?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const qs = g.spec.target.queries;
  const ds = days(g);
  const goal = g.spec.target.value;
  // Pad the axis out to the deadline: the empty run of days IS the "22 days left".
  const future: string[] = [];
  if (ds.length) {
    for (let t = Date.parse(`${ds.at(-1)!.date}T12:00:00`) + 86400_000; future.length < 90; t += 86400_000) {
      const d = localDay(new Date(t).toISOString());
      if (d > g.spec.deadline) break;
      future.push(d);
    }
  }
  const n = ds.length + future.length;
  const maxDepth = Math.max(10, ...g.log.flatMap((r) => qs.map((q) => depthOf(r, q))));
  const scaleMax = maxDepth <= 10 ? 10 : 50 >= maxDepth ? 50 : 100;

  const fs = compact ? 10 : 11;
  const L = compact ? 62 : 84, R = 10, T = 10;
  const laneH = compact ? 22 : 26;
  const plotB = height - 22 - laneH * 2 - 10; // bottom of the rank zone
  const nfY = plotB + 10 + laneH / 2, failY = nfY + laneH;
  const y = (p: number) => T + 6 + (Math.log(Math.min(p, scaleMax)) / Math.log(scaleMax)) * (plotB - T - 12);
  // Piecewise x: the days that HAVE data get at least 62% of the width, the days still to go share the rest.
  // Linear, a week of history beside 22 empty days was squeezed into the left quarter — the part being asked about.
  const span = W - L - R - 16;
  const pastW = future.length ? Math.max(span * 0.62, (span * (ds.length - 1)) / Math.max(1, n - 1)) : span;
  const pastStep = ds.length > 1 ? pastW / (ds.length - 1) : 0;
  const futStep = future.length ? (span - pastW) / future.length : 0;
  const step = pastStep || futStep;
  const x = (i: number) => L + 8 + (i < ds.length ? i * pastStep : pastW + (i - ds.length + 1) * futStep);
  const off = (k: number) => (qs.length > 1 ? (k - (qs.length - 1) / 2) * Math.min(5, step / 3) : 0);
  const bands: [string, number, number, string][] = [
    ["Top 3", 1, 3, "rgba(62,207,142,.09)"],
    ["Page 1", 3, 10, "rgba(255,255,255,.045)"],
    ...(scaleMax > 10 ? [[scaleMax === 50 ? "Pages 2–5" : "Pages 2–10", 10, scaleMax, "rgba(255,255,255,.025)"] as [string, number, number, string]] : []),
  ];
  const todayI = ds.length - 1;

  return (
    <div ref={box} className="w-full">
      {/* Legend: one entry per query, and the three marks the lanes use. */}
      <div className={`mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 ${compact ? "text-[11px]" : "text-[12px]"}`} style={{ color: "rgba(255,255,255,.6)" }}>
        {qs.map((q, k) => <span key={q} className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full" style={{ background: SERIES[k % SERIES.length] }} />“{q}”</span>)}
        <span className="flex items-center gap-1.5"><i className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: GREEN }} />goal #{goal}</span>
      </div>
      {W > 0 && (
        <svg width={W} height={height} className="block" role="img" aria-label={`Google rank per day for ${qs.join(", ")}`}>
          {/* Rank zone */}
          {bands.map(([l, a, b, fill]) => (
            <g key={l}>
              <rect x={L} y={y(a) - 6} width={W - L - R} height={y(b) - y(a) + (b === scaleMax ? 6 : 0)} fill={fill} />
              <text x={L - 8} y={(y(a) + y(b)) / 2 + 4} fontSize={fs} textAnchor="end" fill="rgba(255,255,255,.55)">{l}</text>
            </g>
          ))}
          <line x1={L} x2={W - R} y1={y(goal)} y2={y(goal)} stroke={GREEN} strokeWidth={1.5} strokeDasharray="5 4" />
          <text x={L - 8} y={y(goal) + 4} fontSize={fs} fontWeight={600} textAnchor="end" fill={GREEN}>Goal #{goal}</text>

          {/* Lanes */}
          <rect x={L} y={nfY - laneH / 2 + 2} width={W - L - R} height={laneH - 4} rx={5} fill="rgba(255,138,141,.08)" />
          <text x={L - 8} y={nfY + 4} fontSize={fs} textAnchor="end" fill="rgba(255,138,141,.9)">Not found</text>
          <rect x={L} y={failY - laneH / 2 + 2} width={W - L - R} height={laneH - 4} rx={5} fill="rgba(255,255,255,.03)" />
          <text x={L - 8} y={failY + 4} fontSize={fs} textAnchor="end" fill="rgba(255,255,255,.45)">{compact ? "Failed" : "Check failed"}</text>

          {/* The days still to go: shaded, with the count where the eye lands. */}
          {future.length > 0 && (
            <g>
              <rect x={x(todayI) + (futStep || step) / 2} y={T - 4} width={W - R - (x(todayI) + (futStep || step) / 2)} height={failY + laneH / 2 - T + 2} fill="rgba(255,255,255,.025)" />
              <line x1={x(todayI) + (futStep || step) / 2} x2={x(todayI) + (futStep || step) / 2} y1={T - 4} y2={failY + laneH / 2} stroke="rgba(255,255,255,.18)" />
              <text x={x(todayI) + (futStep || step) / 2 + 8} y={(y(10) + y(scaleMax)) / 2 + 4} fontSize={fs} fill="rgba(255,255,255,.45)">
                {future.length} day{future.length === 1 ? "" : "s"} left → {dayLabel(g.spec.deadline)}
              </text>
            </g>
          )}

          {/* Lines between consecutive days that both have a rank. */}
          {qs.map((q, k) => {
            const pts = ds.map((d, i) => ({ i, p: d.run?.positions[q] })).filter((v): v is { i: number; p: number } => typeof v.p === "number");
            return pts.slice(1).map((b, j) => {
              const a = pts[j];
              if (b.i - a.i !== 1) return null;
              return <line key={`${q}${b.i}`} x1={x(a.i) + off(k)} y1={y(a.p)} x2={x(b.i) + off(k)} y2={y(b.p)} stroke={SERIES[k % SERIES.length]} strokeWidth={2} />;
            });
          })}

          {/* One column per day: a hover target with the day's readings in words, and each query's mark. */}
          {ds.map((d, i) => {
            const words = qs.map((q) => {
              const p = d.run?.positions[q];
              return `“${q}”: ${!d.run ? "no run" : typeof p === "number" ? `#${p}` : p === null ? `not in the top ${depthOf(d.run, q)}` : "check failed"}`;
            }).join("\n");
            return (
              <g key={d.date}>
                <title>{`${dayLabel(d.date)}\n${words}`}</title>
                <rect x={x(i) - Math.max(step, 12) / 2} y={T - 4} width={Math.max(step, 12)} height={failY + laneH / 2 - T + 2} fill="transparent" />
                {qs.map((q, k) => {
                  const p = d.run?.positions[q], c = SERIES[k % SERIES.length], cx = x(i) + off(k);
                  if (!d.run || p === undefined) return null;
                  if (typeof p === "number") return <g key={q}><circle cx={cx} cy={y(p)} r={compact ? 4 : 4.5} fill={c} />{(i === todayI || !compact) && <text x={cx} y={y(p) - 8} fontSize={fs} textAnchor="middle" fill={c}>#{p}</text>}</g>;
                  // One "?" per day: a failed check fails for every query at once, and two marks read as "??".
                  if (p === "no reading") return qs.findIndex((x) => d.run?.positions[x] === "no reading") === k ? <text key={q} x={x(i)} y={failY + 4} fontSize={fs} textAnchor="middle" fill="rgba(255,255,255,.5)">?</text> : null;
                  return <circle key={q} cx={cx} cy={nfY} r={compact ? 3.5 : 4} fill="none" stroke={c} strokeWidth={1.75} />;
                })}
              </g>
            );
          })}
          {/* How deep the newest not-found check looked — the number the old card showed as if it were a rank. */}
          {(() => {
            const r = ds[todayI]?.run;
            if (!r) return null;
            const deep = qs.filter((q) => r.positions[q] === null).map((q) => depthOf(r, q));
            if (!deep.length) return null;
            const lo = Math.min(...deep), hi = Math.max(...deep);
            return <text x={x(todayI) + 9} y={nfY + 4} fontSize={fs} fill="rgba(255,138,141,.95)">read top {lo === hi ? lo : `${lo}–${hi}`}</text>;
          })()}

          {/* Day axis */}
          {/* Day axis. Spacing differs either side of today, so labels are placed greedily by PIXEL gap: today and
              the deadline first, then every day that keeps clear of the ones already placed. */}
          {(() => {
            const all = [...ds.map((d) => d.date), ...future];
            const gap = compact ? 40 : 52;
            const keep = new Set<number>([todayI, n - 1]);
            for (let i = 0; i < n; i++) if ([...keep].every((k) => Math.abs(x(i) - x(k)) >= gap)) keep.add(i);
            return [...keep].map((i) => (
              <text key={all[i]} x={x(i)} y={height - 6} fontSize={fs} textAnchor={i === n - 1 && i !== todayI ? "end" : "middle"} fontWeight={i === todayI ? 600 : 400}
                fill={i === todayI ? "rgba(255,255,255,.85)" : "rgba(255,255,255,.4)"}>{i === todayI ? "Today" : dayLabel(all[i])}</text>
            ));
          })()}
        </svg>
      )}
    </div>
  );
}
