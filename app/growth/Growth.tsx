"use client";
// The Growth page (§35), pitch posthog-growth F2 "Source ledger, with totals" (picked 2026-10-24):
//   • totals — traffic → signups → paid → visit→paid as four cards, each with its rate and its change
//   • the days — traffic per day for the picked source, signup bars under it (◆ = a payment)
//   • the ledger — every source (traffic + share, signups + rate, paid, visit→paid), then All sources
// A ledger row IS the filter: tap one and the cards and the days follow it. Pictures first, a number,
// at most a short label (his note on round 1: "less talk, more visualisation").
// Numbers come from lib/growth.ts's once-a-day pull, so opening this never waits on PostHog.
import { useCallback, useEffect, useState } from "react";
import type { Growth as G, GrowthSource as Src } from "@/lib/growth";

const BLUE = "#7aa2ff", GREEN = "#5fd39a", AMBER = "#f3c766", RED = "#ff7b7f";
const PAL = [BLUE, GREEN, "#c79bff", AMBER, "#5fc8d3", "#ff9f6b", "#e58fb8", "#9fd35f"];
/** Under this many in either week a change is "too few" and stays grey, so 3 → 5 never reads as +67%. */
const MIN_N = 50;

const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US"));
const rate = (a: number | null, b: number | null) => (a == null || b == null || !b ? null : (a / b) * 100);
const pctTxt = (r: number | null) => (r == null ? "—" : r === 0 ? "0%" : r < 1 ? `${r.toFixed(2)}%` : r < 10 ? `${r.toFixed(1)}%` : `${Math.round(r)}%`);
const colorOf = (list: Src[], key: string) => (key === "All" ? BLUE : PAL[(list.findIndex((s) => s.key === key) - 1) % PAL.length]);

const card = "rounded-[14px] border border-white/[.07] bg-[#13161c]";

/** A filled line; the last point (today, partial) dashed. */
function Spark({ xs, c = BLUE, h = 40 }: { xs: number[]; c?: string; h?: number | string }) {
  if (xs.length < 2) return <div style={{ height: h }} />;
  const max = Math.max(1, ...xs), n = xs.length - 1;
  const pt = (v: number, i: number) => `${(i / n) * 100},${96 - (v / max) * 88}`;
  const line = xs.slice(0, -1).map(pt).join(" ");
  const id = `gs${c.slice(1)}${String(h).replace("%", "p")}`;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: "100%", height: h, display: "block" }}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={c} stopOpacity=".35" /><stop offset="1" stopColor={c} stopOpacity="0" /></linearGradient></defs>
      <polygon points={`0,100 ${line} ${((n - 1) / n) * 100},100`} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke={c} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <polyline points={`${pt(xs[n - 1], n - 1)} ${pt(xs[n], n)}`} fill="none" stroke={c} strokeWidth="2" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" opacity=".6" />
    </svg>
  );
}

function Days({ dates }: { dates: string[] }) {
  return <div className="flex justify-between text-[10.5px] text-neutral-500 tabular-nums">{dates.map((d, i) => <span key={d} className={i % 2 ? "max-sm:invisible" : ""}>{d.slice(8)}</span>)}</div>;
}

function SignBars({ s, h }: { s: Src; h: number }) {
  const xs = s.days.map((d) => d.signups ?? 0), max = Math.max(1, ...xs);
  return (
    <div className="flex items-end gap-[3px]" style={{ height: h }}>
      {s.days.map((d, i) => (
        <div key={i} className="flex h-full flex-1 flex-col items-center justify-end">
          {!!d.paid && <span className="mb-0.5 text-[10px] leading-none" style={{ color: AMBER }}>◆</span>}
          <i className="w-full rounded-sm" style={{ height: `${Math.max(3, ((d.signups ?? 0) / max) * (h - 14))}px`, background: GREEN, opacity: i === s.days.length - 1 ? .4 : .85 }} />
        </div>
      ))}
    </div>
  );
}

const Untracked = ({ h }: { h: number }) => (
  <div className="flex items-center justify-center rounded-md border border-dashed text-[11px]" style={{ height: h, borderColor: "rgba(243,199,102,.35)", color: AMBER }}>not tracked yet</div>
);

/** Change vs last week: coloured only past ±10% with enough volume; grey with a reason otherwise. */
function Chg({ a, b, thin }: { a: number | null; b: number | null; thin: string | null }) {
  if (a == null || b == null) return null;
  if (thin) return <span className="text-[11px] text-neutral-500 tabular-nums">was {fmt(b)} · {thin}</span>;
  if (!b) return <span className="text-[11px] text-neutral-500">new this week</span>;
  if (Math.min(a, b) < MIN_N) return <span className="text-[11px] text-neutral-500 tabular-nums">was {fmt(b)} · too few</span>;
  const d = Math.round(((a - b) / b) * 100);
  if (Math.abs(d) < 1) return <span className="text-[11.5px] text-neutral-400 tabular-nums">≈ same <span className="text-neutral-500">vs {fmt(b)}</span></span>;
  const c = Math.abs(d) < 10 ? "#9a9a9a" : d > 0 ? GREEN : RED;
  return <span className="text-[11.5px] font-semibold tabular-nums" style={{ color: c }}>{d > 0 ? "▲" : "▼"} {Math.abs(d)}% <span className="font-normal text-neutral-500">vs {fmt(b)}</span></span>;
}

function Card({ label, n, text, sub, chg, c, xs }: { label: string; n: number | null; text?: string; sub?: string; chg?: React.ReactNode; c: string; xs?: number[] }) {
  return (
    <div className={`${card} relative flex min-h-[118px] flex-col overflow-hidden px-3 pb-7 pt-2.5 sm:min-h-[132px] sm:px-3.5 sm:pt-3`}>
      <div className="flex items-center gap-1.5 text-[12px] text-neutral-400"><i className="h-2 w-2 rounded-full" style={{ background: c }} />{label}</div>
      <div className="mt-1.5 text-[28px] font-semibold leading-none tabular-nums sm:text-[34px]" style={{ color: n == null ? AMBER : "#f2f2f2" }}>{n == null ? "?" : text ?? fmt(n)}</div>
      {sub && <div className="mt-1 text-[12px] text-neutral-400 tabular-nums">{sub}</div>}
      <div className="mt-0.5">{n == null ? <span className="text-[11px]" style={{ color: AMBER }}>not tracked yet</span> : chg}</div>
      {xs && n != null && <div className="absolute inset-x-0 bottom-0 opacity-70"><Spark xs={xs} c={c} h={26} /></div>}
    </div>
  );
}

function useGrowth() {
  const [g, setG] = useState<G | null>(null), [busy, setBusy] = useState(false);
  const load = useCallback(async (force = false) => {
    setBusy(true);
    try { setG(await (await fetch("/api/growth", { method: force ? "POST" : "GET", cache: "no-store" })).json()); } finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { g, busy, refresh: () => load(true) };
}

export function Growth() {
  const { g, busy, refresh } = useGrowth();
  const [on, set] = useState("All");
  if (!g) return <div className="p-6 text-sm text-neutral-500">Reading PostHog…</div>;
  if (!g.sources.length) return <div className="p-6 text-sm text-neutral-400">Growth needs PostHog. {g.error}</div>;

  const list = g.sources, rows = list.slice(1), all = list[0], s = list.find((x) => x.key === on) ?? all;
  const isAll = s.key === "All", w = s.week, c = colorOf(list, s.key);
  const maxV = Math.max(1, ...rows.map((r) => r.week.visitors)), maxR = Math.max(1, ...rows.map((r) => rate(r.week.signups, r.week.visitors) ?? 0));
  const share = (r: Src) => rate(r.week.visitors, all.week.visitors);
  // Last week only counts if PostHog had data for all of it: data that starts mid-week makes any change huge.
  const first = all.days.findIndex((d) => d.visitors > 0), prevDays = first < 0 ? 0 : Math.max(0, 7 - first);
  const thin = prevDays < 7 ? (prevDays ? `only ${prevDays} day${prevDays > 1 ? "s" : ""} of data` : "no data last week") : null;
  const pulled = new Date(g.pulledAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const cols = "118px minmax(0,1.5fr) minmax(0,1.2fr) 64px 70px";

  const row = (r: Src, total = false) => {
    const rc = colorOf(list, r.key), rr = rate(r.week.signups, r.week.visitors), sel = r.key === s.key;
    const traffic = <span className="relative flex h-6 min-w-0 items-center"><i className="absolute inset-y-0.5 left-0 rounded" style={{ width: `${total ? 100 : (r.week.visitors / maxV) * 100}%`, background: `${rc}${total ? "33" : "55"}` }} /><span className="relative whitespace-nowrap pl-1.5 text-[12.5px] tabular-nums"><b>{fmt(r.week.visitors)}</b> <span className="text-neutral-400">· {total ? "100%" : pctTxt(share(r))}</span></span></span>;
    const sign = r.week.signups == null ? <span className="text-[11.5px]" style={{ color: AMBER }}>not tracked</span> : <span className="relative flex h-6 min-w-0 items-center"><i className="absolute inset-y-0.5 left-0 rounded" style={{ width: `${Math.max(2, ((rr ?? 0) / maxR) * 100)}%`, background: `${GREEN}55` }} /><span className="relative whitespace-nowrap pl-1.5 text-[12.5px] tabular-nums"><b>{fmt(r.week.signups)}</b> <span className="text-neutral-400">· {pctTxt(rr)}</span></span></span>;
    const paid = r.week.paid == null ? <span className="text-[11.5px]" style={{ color: AMBER }}>—</span> : <span className="text-[13px] tabular-nums" style={{ color: r.week.paid ? AMBER : "#555" }}>{r.week.paid ? (r.week.paid > 3 ? `◆ ${r.week.paid}` : "◆".repeat(r.week.paid)) : "0"}</span>;
    const name = <span className="flex min-w-0 items-center gap-2 text-[13px]">{!total && <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: rc }} />}<span className={`truncate ${total ? "font-semibold" : ""}`}>{total ? "All sources" : r.name}</span></span>;
    const style = { background: sel ? "rgba(255,255,255,.08)" : undefined, ...(total ? { borderTop: "1px solid rgba(255,255,255,.1)", marginTop: 4, paddingTop: 6 } : {}) };
    return (
      <button key={r.key} onClick={() => set(r.key)} className="rounded-lg px-2 py-1.5 text-left sm:py-1" style={style}>
        <div className="sm:hidden">
          <div className="flex items-center gap-2">{name}<span className="ml-auto">{paid}</span></div>
          <div className="mt-0.5 grid grid-cols-2 gap-2">{traffic}{sign}</div>
        </div>
        <div className="hidden items-center gap-3 sm:grid" style={{ gridTemplateColumns: cols }}>
          {name}{traffic}{sign}<span className="text-center">{paid}</span><span className="text-right text-[12px] tabular-nums text-neutral-400">{pctTxt(rate(r.week.paid, r.week.visitors))}</span>
        </div>
      </button>
    );
  };

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-3.5 px-4 py-4 sm:px-6 sm:py-5">
      <div className="flex items-baseline gap-2.5">
        <b className="text-[18px] font-semibold">Growth</b>
        <small className="text-[12.5px] text-neutral-500">{g.site} · pulled {pulled}</small>
        <button onClick={refresh} disabled={busy} className="ml-auto rounded-full bg-white/[.06] px-2.5 py-1 text-[12px] text-neutral-400 hover:text-neutral-200 disabled:opacity-50">{busy ? "Pulling…" : "↻ Pull now"}</button>
      </div>
      {g.error && <div className="rounded-lg border border-[#ff7b7f]/30 px-3 py-2 text-[12px] text-[#ff7b7f]">Last pull failed, showing the one before: {g.error}</div>}

      {/* Totals: the funnel as four cards, following the picked row. */}
      <div>
        <div className="mb-1.5 flex items-baseline justify-between"><span className="text-[13px] font-semibold" style={{ color: isAll ? "#f2f2f2" : c }}>{isAll ? "All sources" : s.name}</span><span className="text-[11.5px] text-neutral-500">last 7 days{isAll ? "" : ` · ${pctTxt(share(s))} of traffic`}</span></div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Card label="Traffic" n={w.visitors} c={c} xs={s.days.map((d) => d.visitors)} chg={isAll ? <Chg a={w.visitors} b={s.prev.visitors} thin={thin} /> : <span className="text-[11px] text-neutral-500 tabular-nums">{pctTxt(share(s))} of all traffic</span>} />
          <Card label="Signups" n={w.signups} c={GREEN} sub={`${pctTxt(rate(w.signups, w.visitors))} of traffic`} xs={s.days.map((d) => d.signups ?? 0)} chg={isAll ? <Chg a={w.signups} b={s.prev.signups} thin={thin} /> : <span className="text-[11px] text-neutral-500 tabular-nums">{pctTxt(rate(w.signups, all.week.signups))} of all signups</span>} />
          <Card label="Paid" n={w.paid} c={AMBER} sub={`${pctTxt(rate(w.paid, w.signups))} of signups`} chg={isAll ? <Chg a={w.paid} b={s.prev.paid} thin={thin} /> : <span className="text-[11px] text-neutral-500 tabular-nums">{w.paid ?? 0} of {all.week.paid ?? 0} paid</span>} />
          <Card label="Visit → paid" n={w.paid} text={pctTxt(rate(w.paid, w.visitors))} c={BLUE} sub={w.paid ? `1 in ${fmt(Math.round(w.visitors / w.paid))} visitors pays` : undefined} />
        </div>
      </div>

      {/* The picked source's days. */}
      <div className={`${card} px-3.5 pb-2 pt-2.5`}>
        <div className="mb-1 flex gap-4 text-[11.5px] text-neutral-400"><span><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: c }} />traffic / day</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: GREEN }} />signups / day <span style={{ color: AMBER }}>◆ paid</span></span></div>
        <div className="h-[70px] sm:h-[90px]"><Spark xs={s.days.map((d) => d.visitors)} c={c} h="100%" /></div>
        <div className="mt-1.5">{w.signups != null ? <SignBars s={s} h={40} /> : <Untracked h={30} />}</div>
        <div className="mt-1"><Days dates={g.dates} /></div>
      </div>

      {/* The ledger: every source, then the total. Each row is the filter. */}
      <div className={`${card} px-2.5 py-2 sm:px-3.5 sm:py-2.5`}>
        <div className="hidden gap-3 px-2 pb-1.5 text-[11px] text-neutral-500 sm:grid" style={{ gridTemplateColumns: cols }}><span>Source</span><span>Traffic · share</span><span>Signups · rate</span><span className="text-center">Paid</span><span className="text-right">Visit → paid</span></div>
        <div className="flex flex-col gap-0.5">{rows.map((r) => row(r))}{row(all, true)}</div>
      </div>
      <p className="text-[11.5px] text-neutral-500">The team is left out: PostHog&apos;s internal cohort and anyone who has opened /admin. Each person counts under the source they first came from.</p>
      {(!g.events.signup || !g.events.paid) && (
        <p className="text-[11.5px] text-neutral-500">{[!g.events.signup && "signup", !g.events.paid && "payment"].filter(Boolean).join(" and ")} events aren&apos;t in PostHog yet: set MINAMI_GROWTH_SIGNUP_EVENT / MINAMI_GROWTH_PAID_EVENT once ecvision sends them.</p>
      )}
    </div>
  );
}
