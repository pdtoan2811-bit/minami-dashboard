"use client";
// /autopilot on a phone (§30 → §29, §27): the "Live Activity" version Thomas picked from the autopilot-phone pitch
// (round 4, 2026-10-20), after three rounds that didn't read. What he asked for, and how it's answered here:
//
//   • Shrink · Hide · Embody, with a way to expand — by TAPPING THE THING, like an iPhone Live Activity, never with
//     extra buttons (round 3's "–" / "⤢" controls were things to learn). A goal is a LINE (verdict + one number),
//     a CARD (verdict, four tiles, your part, questions) or FULL SCREEN (one metric, day by day). Runners that are
//     fine are HIDDEN behind one sentence, "✓ 13 others running fine"; a failed one is the only runner drawn as a card.
//   • Read at a glance — every block says its verdict in WORDS first ("Not ranking yet", "Failed"), then the number.
//     The page itself opens with a sentence: "1 goal behind, 1 runner failed. 13 fine."
//   • Real metrics, day by day — a tile opens into its own chart: rank in the SEO convention (#1 on top, bands for
//     top 3 / 10 / 50, the target line), indexed pages, searches, time and spend. One point per day: the last run
//     of that day. A day the check failed says "?" and a day with no run says "–"; neither is drawn as a result.
//   • Ask → chat, as Today's hand-off — questions written for the card sit on it; a tap starts the chat
//     (lib/autopilot-ask.ts), a toast offers "Open chat →", and the chat stays on the card with its state.
//
// The desktop page is unchanged: this replaces the stacked goal and runner cards only below the compact breakpoint,
// where they made the page 8,918px tall.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Goal, GoalRun, Position } from "@/lib/goals";
import type { Automation } from "@/lib/automations";
import type { AutomationsFeed } from "./RunnersSection";
import { K } from "../today/ui";
import { stateOf, useHandoffLive, type HandoffState } from "../today/live";
import { useOpenChat } from "@/components/shell/Drawer";
import { useBackLayer } from "@/lib/use-back";

const C = { green: "#4ade80", amber: "#f0a868", red: "#ef7c7c", blue: "#7aa2ff" };
const tint = (c: string, p: number) => `color-mix(in srgb, ${c} ${p}%, transparent)`;
const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA");
const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" });
const firstSentence = (s = "") => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim();
const ago = (iso?: string | null) => {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

// ── the goal's numbers, one point per day ────────────────────────────────────────────────────────────────
type Day = { date: string; run: GoalRun | null; usd: number };
/** Every calendar day from the first run to today; a day's point is its LAST run, its spend the sum of its runs. */
function days(g: Goal): Day[] {
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
/** ">50" means the check read 50 results and we weren't in them; "?" means the check itself failed. */
const posLabel = (p: Position | undefined, depth = 10) => (typeof p === "number" ? `#${p}` : p === null ? `>${depth}` : p === "no reading" ? "?" : "–");
/** The latest real reading for a query: a captcha day doesn't erase what we last knew. */
function lastReading(g: Goal, q: string): { run: GoalRun; p: Position } | null {
  for (let i = g.log.length - 1; i >= 0; i--) { const p = g.log[i].positions[q]; if (p !== undefined && p !== "no reading") return { run: g.log[i], p }; }
  return null;
}
type Verdict = { word: string; color: string };
function verdict(g: Goal): Verdict {
  const q = g.spec.target.queries ?? [];
  const nums = q.map((x) => lastReading(g, x)?.p).filter((p): p is number => typeof p === "number");
  const last = g.log.at(-1);
  if (!last) return { word: "Not measured yet", color: K.faint };
  if (g.spec.target.metric === "position") {
    if (nums.length && Math.min(...nums) <= g.spec.target.value) return { word: "On target", color: C.green };
    if (nums.length) return { word: `Ranking #${Math.min(...nums)}`, color: last.decision.on_track ? C.blue : C.amber };
    return { word: "Not ranking yet", color: C.amber };
  }
  return last.decision.on_track ? { word: "On track", color: C.green } : { word: "Behind", color: C.amber };
}
/** The goal runner's own trouble ("behind" and "broken" are different news, §29). */
function machineTrouble(g: Goal): string | null {
  const last = g.log.at(-1);
  if (!g.runner.loaded) return "The goal runner isn't loaded, so nothing will run.";
  const broke = last?.actions.filter((a) => a.error || a.refused_by_guard) ?? [];
  if (broke.length) return `Last run: ${broke.map((a) => a.lever).filter((x, i, s) => s.indexOf(x) === i).join(", ")} ${broke.some((a) => a.refused_by_guard) ? "refused" : "failed"}.`;
  if (g.runner.lastExit != null && g.runner.lastExit !== 0) return `The last run exited with code ${g.runner.lastExit}.`;
  if (last && Date.now() - Date.parse(last.at) > 30 * 3600e3) return `No run since ${dayLabel(localDay(last.at))}.`;
  return null;
}
const behind = (g: Goal) => verdict(g).color !== C.green;
const searches = (r: GoalRun | null, q: string[]) => (r ? q.reduce((s, x) => s + (r.gsc[x]?.impressions ?? 0), 0) : 0);

// ── asks: questions sent from a card, and the chats they started ─────────────────────────────────────────
type Ask = { kind: "goal" | "runner"; id: string; question: string; sessionId: string; at: string };
function useAsks() {
  const [asks, setAsks] = useState<Ask[]>([]);
  const [toast, setToast] = useState<{ text: string; sid?: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => fetch("/api/autopilot/ask").then((r) => r.json()).then((j) => setAsks(j.asks ?? [])).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 7000); return () => clearTimeout(t); }, [toast]);
  const ask = useCallback(async (kind: Ask["kind"], id: string, question: string) => {
    setBusy(`${kind}:${id}:${question}`);
    try {
      const r = await fetch("/api/autopilot/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, id, question }) }).then((r) => r.json());
      if (r.error) setToast({ text: r.error, error: true });
      else { setToast({ text: `Asked Minami: ${question}`, sid: r.sessionId }); load(); }
    } catch { setToast({ text: "Couldn't reach the dashboard.", error: true }); }
    finally { setBusy(null); }
  }, [load]);
  return { asks, ask, toast, setToast, busy };
}
type Asks = ReturnType<typeof useAsks>;
const CHAT_WORD: Record<HandoffState, [string, string]> = {
  running: ["working", C.amber], needs: ["needs you", C.green], failed: ["failed", C.red], finished: ["ready", C.green], gone: ["ready", C.green],
};

// ── small parts ──────────────────────────────────────────────────────────────────────────────────────────
const Pill = ({ v }: { v: Verdict }) => (
  <span className="inline-flex h-[26px] shrink-0 items-center whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-semibold" style={{ color: v.color, background: tint(v.color, 14) }}>{v.word}</span>
);
const Q = ({ children, onClick, busy }: { children: ReactNode; onClick: () => void; busy?: boolean }) => (
  <button onClick={onClick} disabled={busy} className="inline-flex h-9 items-center whitespace-nowrap rounded-full px-3.5 text-[13px] transition-opacity active:opacity-70 disabled:opacity-50"
    style={{ background: tint(C.blue, 15), color: C.blue }}>{busy ? "Starting…" : children}</button>
);
function Tile({ label, value, ctx, tone, onClick, children }: { label: string; value: ReactNode; ctx: ReactNode; tone?: string; onClick: () => void; children?: ReactNode }) {
  return (
    <button onClick={onClick} className="flex min-w-0 flex-col items-start gap-1 rounded-2xl px-3 py-2.5 text-left active:bg-white/[0.08]" style={{ background: "rgba(0,0,0,.24)" }}>
      <span className="text-[10.5px] font-semibold tracking-[.09em]" style={{ color: K.faint }}>{label}</span>
      <b className="text-[24px] font-semibold leading-none" style={{ color: tone }}>{value}</b>
      {children}
      <span className="text-[11.5px]" style={{ color: K.faint }}>{ctx}</span>
    </button>
  );
}
/** One dot per day for the last seven days: red = outside the results read, blue = ranked, grey = no reading. */
function Week({ ds, q }: { ds: Day[]; q: string }) {
  return <span className="flex gap-[3px]">{ds.slice(-7).map((d) => {
    const p = d.run?.positions[q];
    return <i key={d.date} className="h-[9px] w-[9px] rounded-[3px]" style={{ background: typeof p === "number" ? C.blue : p === null ? tint(C.red, 80) : "rgba(255,255,255,.16)" }} />;
  })}</span>;
}
function AskRows({ asks, live, kind, id, onOpen }: { asks: Ask[]; live: ReturnType<typeof useHandoffLive>; kind: Ask["kind"]; id: string; onOpen: (sid: string) => void }) {
  const mine = asks.filter((a) => a.kind === kind && a.id === id).slice(-3).reverse();
  if (!mine.length) return null;
  return (
    <div className="mt-3 space-y-1.5">
      {mine.map((a) => {
        const [w, c] = CHAT_WORD[stateOf(live[a.sessionId])];
        return (
          <button key={a.sessionId} onClick={() => onOpen(a.sessionId)} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left active:bg-white/10" style={{ background: "rgba(0,0,0,.25)" }}>
            <span className="text-[12px]">💬</span>
            <span className="min-w-0 flex-1 truncate text-[13px]">{a.question}</span>
            <span className="shrink-0 text-[12px]" style={{ color: c }}>{w === "working" ? "◌ working" : w}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── a goal: line, card, full screen ──────────────────────────────────────────────────────────────────────
type Metric = "rank" | "indexed" | "searches" | "time";
function GoalLine({ g, onGrow }: { g: Goal; onGrow: () => void }) {
  const v = verdict(g), last = g.log.at(-1);
  return (
    <button onClick={onGrow} className="mx-3 mb-2 flex w-[calc(100%-1.5rem)] items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left active:bg-white/10"
      style={{ background: `linear-gradient(90deg, ${tint(C.blue, 16)}, rgba(255,255,255,.03))`, border: `1px solid ${tint(C.blue, 30)}` }}>
      <Pill v={v} />
      <span className="min-w-0 flex-1 truncate text-[13.5px]">{g.spec.goal}{last?.index ? ` · ${last.index.indexed}/${last.index.total} indexed` : ""}</span>
      <span className="shrink-0 text-[12px]" style={{ color: K.faint }}>{Math.max(0, g.daysLeft)}d</span>
    </button>
  );
}
function GoalCard({ g, ds, a, onShrink, onMetric, onResolve, resolving }: {
  g: Goal; ds: Day[]; a: Asks & { live: ReturnType<typeof useHandoffLive>; open: (sid: string) => void };
  onShrink: () => void; onMetric: (m: Metric) => void; onResolve: () => void; resolving: boolean;
}) {
  const v = verdict(g), last = g.log.at(-1), q = g.spec.target.queries ?? [];
  const trouble = machineTrouble(g);
  const idx = ds.filter((d) => d.run?.index), cur = idx.at(-1)?.run?.index, prev = idx.at(-2)?.run?.index;
  const delta = cur && prev ? cur.indexed - prev.indexed : null;
  const best = q.map((x) => ({ x, r: lastReading(g, x) })).sort((m, n) => (typeof m.r?.p === "number" ? m.r.p : 1e9) - (typeof n.r?.p === "number" ? n.r.p : 1e9))[0];
  const total = g.spec.started ? Math.max(1, Math.round((Date.parse(g.spec.deadline) - Date.parse(g.spec.started)) / 86400_000)) : null;
  const todo = g.today?.todos.find((t) => !t.done);
  const ranking = v.word === "Not ranking yet";
  const qs = [ranking ? "Why no rank yet?" : "What moved this week?", "What do I do this week?", "Report"];
  const ask = (s: string) => a.ask("goal", g.spec.id, s === "Report" ? "Write me a short report on this goal: where it stands, what changed day by day, and what's next." : s);
  return (
    <div id={`goal-${g.spec.id}`} className="mx-3 rounded-[18px] p-3.5" style={{ background: `linear-gradient(160deg, ${tint(C.blue, 14)}, rgba(255,255,255,.03))`, border: `1px solid ${tint(C.blue, 30)}` }}>
      {/* Tapping the header shrinks the card back to its line: the same thing you tapped to grow it. */}
      <button onClick={onShrink} className="block w-full text-left" aria-label="Shrink">
        <span className="flex items-center gap-2"><Pill v={v} /><span className="ml-auto truncate text-[12px]" style={{ color: K.faint }}>Goal · {g.note}</span><span className="text-[13px]" style={{ color: K.faint }}>⌃</span></span>
        <span className="mt-2 block text-[16px] font-semibold leading-snug">{g.spec.goal}</span>
        {last && <span className="mt-0.5 block text-[13px] leading-snug" style={{ color: K.muted }}>{firstSentence(last.decision.assessment)}</span>}
      </button>
      {trouble && <p className="mt-2 flex items-start gap-2 text-[12.5px]" style={{ color: "#f0c08a" }}><i className="mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: C.amber }} />{trouble}</p>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {g.spec.target.metric === "position" && best && (
          <Tile label="RANK" onClick={() => onMetric("rank")} tone={typeof best.r?.p === "number" ? (best.r.p <= g.spec.target.value ? C.green : undefined) : C.red}
            value={best.r ? posLabel(best.r.p, best.r.run.depth?.[best.x]) : "–"} ctx={`target #${g.spec.target.value}${q.length > 1 ? ` · best of ${q.length}` : ""}`}>
            <Week ds={ds} q={best.x} />
          </Tile>
        )}
        <Tile label="INDEXED" onClick={() => onMetric("indexed")} value={cur ? <>{cur.indexed}<i className="not-italic text-[14px] font-medium" style={{ color: K.faint }}>/{cur.total}</i></> : "–"}
          ctx={delta ? <span style={{ color: delta > 0 ? C.green : C.red }}>{delta > 0 ? "▲" : "▼"}{Math.abs(delta)} since last run</span> : "pages in Google"} />
        <Tile label="SEARCHES" onClick={() => onMetric("searches")} value={String(searches(last ?? null, q))} ctx="Search Console · 7d" />
        <Tile label="TIME" onClick={() => onMetric("time")} value={<>{Math.max(0, g.daysLeft)}<i className="not-italic text-[14px] font-medium" style={{ color: K.faint }}> days</i></>}
          ctx={total ? `day ${Math.min(total, total - g.daysLeft)} of ${total}` : `deadline ${dayLabel(g.spec.deadline)}`}>
          {total && <span className="flex w-full gap-[2px]">{Array.from({ length: Math.min(total, 40) }).map((_, i) => <i key={i} className="h-[5px] flex-1 rounded-[2px]" style={{ background: i < Math.round(((total - g.daysLeft) / total) * Math.min(total, 40)) ? C.blue : "rgba(255,255,255,.1)" }} />)}</span>}
        </Tile>
      </div>
      {todo && (
        <div className="mt-3 flex items-center gap-2 rounded-xl px-3 py-2.5" style={{ background: tint(C.green, 7), border: `1px solid ${tint(C.green, 25)}` }}>
          <span className="min-w-0 flex-1"><span className="block text-[11px] font-semibold tracking-[.09em]" style={{ color: C.green }}>YOUR PART</span><span className="line-clamp-2 text-[13.5px] leading-snug">{todo.text}</span></span>
          <button onClick={onResolve} disabled={resolving} className="h-9 shrink-0 rounded-[10px] px-3 text-[13px] disabled:opacity-50" style={{ color: C.blue, border: `1px solid ${tint(C.blue, 45)}` }}>{resolving ? "Starting…" : "Resolve with Minami"}</button>
        </div>
      )}
      <AskRows asks={a.asks} live={a.live} kind="goal" id={g.spec.id} onOpen={a.open} />
      <div className="mt-3 flex flex-wrap gap-1.5">{qs.map((s) => <Q key={s} onClick={() => ask(s)} busy={a.busy?.startsWith(`goal:${g.spec.id}:`) && a.busy.endsWith(s === "Report" ? "next." : s)}>{s}</Q>)}</div>
    </div>
  );
}

/** One metric, full screen, day by day. Tabs swap metrics; Back (or the phone's back) closes it. */
function GoalFull({ g, ds, metric, setMetric, onClose, a }: { g: Goal; ds: Day[]; metric: Metric; setMetric: (m: Metric) => void; onClose: () => void; a: Asks }) {
  useBackLayer(true, onClose);
  const q = g.spec.target.queries ?? [];
  const [qi, setQi] = useState(0);
  const tabs: [Metric, string][] = [...(g.spec.target.metric === "position" ? [["rank", "Rank"] as [Metric, string]] : []), ["indexed", "Indexed"], ["searches", "Searches"], ["time", "Time & spend"]];
  const notes = [...ds].reverse().filter((d) => d.run).slice(0, 5);
  return (
    <div className="fixed inset-0 z-[80] flex flex-col" style={{ background: "#0d1016" }} role="dialog" aria-label={`${g.spec.goal}: ${metric}`}>
      <div className="px-4 pb-2 pt-[max(1rem,env(safe-area-inset-top))]">
        <div className="flex items-center"><button onClick={onClose} className="h-10 pr-3 text-[14.5px]" style={{ color: C.blue }}>‹ Goal</button></div>
        <div className="mt-1 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {tabs.map(([m, l]) => <button key={m} onClick={() => setMetric(m)} className="h-8 shrink-0 rounded-full px-3 text-[13px]" style={m === metric ? { background: "rgba(255,255,255,.16)", color: "#fff", fontWeight: 600 } : { background: "rgba(255,255,255,.05)", color: K.muted }}>{l}</button>)}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {metric === "rank" && <RankView g={g} ds={ds} q={q[qi] ?? q[0]} qs={q} qi={qi} setQi={setQi} />}
        {metric === "indexed" && <BarsView title="pages indexed" ds={ds} get={(r) => r.index?.indexed ?? null} max={(r) => r.index?.total ?? null} unit={(d) => d.run?.index ? `of ${d.run.index.total}` : ""} sub="Pages Google has indexed from the sitemap" />}
        {metric === "searches" && <BarsView title="searches seen" ds={ds} get={(r) => searches(r, q)} sub={`Search Console impressions for ${q.map((x) => `“${x}”`).join(" and ")}, last 7 days at each run`} />}
        {metric === "time" && <TimeView g={g} ds={ds} />}
        <p className="mt-5 text-[10.5px] font-semibold tracking-[.09em]" style={{ color: K.faint }}>WHAT IT SAID</p>
        {notes.map((d) => (
          <div key={d.date} className="flex gap-3 py-1.5 text-[13px]"><span className="w-14 shrink-0 text-[11.5px]" style={{ fontFamily: "var(--today-mono)", color: K.faint }}>{dayLabel(d.date)}</span><span className="leading-snug" style={{ color: K.muted }}>{firstSentence(d.run!.decision.assessment)}</span></div>
        ))}
        <div className="mt-4 flex flex-wrap gap-1.5">
          {(metric === "rank" ? ["Why is the top result ahead of us?", "What would move the rank?"] : metric === "indexed" ? ["Which pages aren't indexed, and why?"] : ["What do I do this week?"])
            .map((s) => <Q key={s} onClick={() => a.ask("goal", g.spec.id, s)} busy={a.busy === `goal:${g.spec.id}:${s}`}>{s}</Q>)}
        </div>
      </div>
    </div>
  );
}
function Big({ verdict: v, value, rest, sub }: { verdict: Verdict; value: string; rest: string; sub: string }) {
  return (
    <>
      <Pill v={v} />
      <p className="mt-2 text-[24px] font-semibold">{value} <span className="text-[15px] font-normal" style={{ color: K.faint }}>{rest}</span></p>
      <p className="text-[12.5px]" style={{ color: K.faint }}>{sub}</p>
    </>
  );
}
function RankView({ g, ds, q, qs, qi, setQi }: { g: Goal; ds: Day[]; q: string; qs: string[]; qi: number; setQi: (i: number) => void }) {
  const lr = lastReading(g, q);
  const depth = Math.max(10, ...g.log.map((r) => r.depth?.[q] ?? 10));
  const checked = ds.filter((d) => d.run && d.run.positions[q] !== "no reading" && d.run.positions[q] !== undefined).length;
  const fails = ds.filter((d) => d.run?.positions[q] === "no reading").length;
  const above = [...g.log].reverse().find((r) => r.above?.[q]?.length)?.above?.[q] ?? [];
  const aboveDay = [...g.log].reverse().find((r) => r.above?.[q]?.length);
  const v: Verdict = typeof lr?.p === "number" ? (lr.p <= g.spec.target.value ? { word: "On target", color: C.green } : { word: `Ranking #${lr.p}`, color: C.amber }) : { word: `Outside the top ${depth}`, color: C.red };
  // The SEO convention: #1 at the top on a log scale, bands for top 3 / 10 / depth, and a floor for "not found".
  const W = 340, H = 180, L = 50, top = 8, floor = H - 44;
  const y = (p: number) => top + 4 + (Math.log(p) / Math.log(depth)) * (floor - top - 16);
  const x = (i: number) => L + 14 + (i * (W - L - 26)) / Math.max(1, ds.length - 1);
  const bands: [string, number, number][] = [["top 3", 1, 3], ["top 10", 3, 10], ...(depth > 10 ? [[`top ${depth}`, 10, depth] as [string, number, number]] : [])];
  return (
    <>
      {qs.length > 1 && <div className="mb-3 flex gap-1.5">{qs.map((x, i) => <button key={x} onClick={() => setQi(i)} className="h-8 rounded-full px-3 text-[13px]" style={i === qi ? { background: tint(C.blue, 22), color: "#fff" } : { background: "rgba(255,255,255,.05)", color: K.muted }}>“{x}”</button>)}</div>}
      <Big verdict={v} value={lr ? posLabel(lr.p, lr.run.depth?.[q]) : "–"} rest={`→ target #${g.spec.target.value}, ${g.spec.target.days} days running`} sub={`“${q}” · checked ${checked} of ${ds.length} days${fails ? ` (${fails} failed checks)` : ""}`} />
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="mt-3 block">
        {bands.map(([l, a, b], i) => <g key={l}><rect x={L} y={y(a)} width={W - L - 4} height={Math.max(8, y(b) - y(a))} rx={5} fill={i === 0 ? "rgba(74,222,128,.07)" : "rgba(255,255,255,.04)"} /><text x={L - 6} y={(y(a) + y(b)) / 2 + 4} fontSize="10" textAnchor="end" fill="rgba(255,255,255,.5)">{l}</text></g>)}
        <rect x={L} y={floor - 10} width={W - L - 4} height={22} rx={5} fill="rgba(239,124,124,.1)" />
        <text x={L - 6} y={floor + 5} fontSize="10" textAnchor="end" fill="rgba(239,124,124,.85)">&gt;{depth}</text>
        <line x1={L} x2={W - 4} y1={y(g.spec.target.value)} y2={y(g.spec.target.value)} stroke={C.green} strokeDasharray="4 4" />
        <text x={W - 6} y={y(g.spec.target.value) + 13} fontSize="9.5" textAnchor="end" fill={C.green}>target #{g.spec.target.value}</text>
        {ds.map((d, i) => {
          const p = d.run?.positions[q];
          return (
            <g key={d.date}>
              {typeof p === "number" && <circle cx={x(i)} cy={y(Math.min(p, depth))} r={4.5} fill={C.blue} />}
              {p === null && <circle cx={x(i)} cy={floor + 1} r={4.5} fill={C.red} />}
              {(p === "no reading" || p === undefined || !d.run) && <text x={x(i)} y={floor + 5} fontSize="11" textAnchor="middle" fill="rgba(255,255,255,.5)">{p === "no reading" ? "?" : "–"}</text>}
              {(ds.length <= 10 || i % Math.ceil(ds.length / 8) === 0 || i === ds.length - 1) && <text x={x(i)} y={H - 8} fontSize="10" textAnchor="middle" fill="rgba(255,255,255,.45)">{d.date.slice(8)}</text>}
            </g>
          );
        })}
      </svg>
      <p className="text-[12px]" style={{ color: K.faint }}>● outside the top {depth} · ? the check failed (e.g. a captcha) · – no run</p>
      {above.length > 0 && aboveDay && (
        <>
          <p className="mt-5 text-[10.5px] font-semibold tracking-[.09em]" style={{ color: K.faint }}>ABOVE YOU · {dayLabel(localDay(aboveDay.at)).toUpperCase()}</p>
          {above.slice(0, 6).map((s, i) => <div key={s} className="flex gap-3 py-[5px] text-[13.5px]"><span className="w-4 tabular-nums" style={{ color: K.faint }}>{i + 1}</span><span className="truncate">{s}</span></div>)}
        </>
      )}
    </>
  );
}
function BarsView({ title, ds, get, max, unit, sub }: { title: string; ds: Day[]; get: (r: GoalRun) => number | null; max?: (r: GoalRun) => number | null; unit?: (d: Day) => string; sub: string }) {
  const vals = ds.map((d) => (d.run ? get(d.run) : null));
  const caps = ds.map((d) => (d.run && max ? max(d.run) : null));
  const top = Math.max(1, ...vals.map((v) => v ?? 0), ...caps.map((v) => v ?? 0));
  const lastI = vals.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop() ?? -1;
  const prevI = vals.map((v, i) => (v == null || i >= lastI ? -1 : i)).filter((i) => i >= 0).pop() ?? -1;
  const d = lastI >= 0 && prevI >= 0 ? vals[lastI]! - vals[prevI]! : null;
  const v: Verdict = d == null ? { word: "One reading so far", color: K.faint } : d > 0 ? { word: "Moving", color: C.green } : d < 0 ? { word: "Dropping", color: C.red } : { word: "Flat", color: C.amber };
  const shown = ds.slice(-10), off = ds.length - shown.length;
  return (
    <>
      <Big verdict={v} value={lastI >= 0 ? String(vals[lastI]) : "–"} rest={`${lastI >= 0 && unit ? unit(ds[lastI]) + " " : ""}${title}${d ? ` · ${d > 0 ? "▲" : "▼"}${Math.abs(d)} since last run` : ""}`} sub={sub} />
      <div className="mt-4 flex items-end gap-2" style={{ height: 160 }}>
        {shown.map((day, j) => {
          const i = j + off, val = vals[i], cap = caps[i];
          const prev = vals.slice(0, i).reverse().find((x) => x != null);
          const dd = val != null && prev != null ? val - prev : null;
          return (
            <div key={day.date} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-[11px] tabular-nums" style={{ color: val != null ? "#fff" : K.faint }}>{val ?? "–"}</span>
              <div className="relative w-full max-w-[34px] overflow-hidden rounded-md" style={{ height: 110 }}>
                {cap != null && <i className="absolute inset-x-0 bottom-0 rounded-md" style={{ height: `${(cap / top) * 100}%`, background: "rgba(255,255,255,.08)" }} />}
                {val != null && <i className="absolute inset-x-0 bottom-0 rounded-md" style={{ height: `${Math.max(2, (val / top) * 100)}%`, background: C.blue }} />}
              </div>
              <span className="text-[10.5px]" style={{ color: K.faint }}>{day.date.slice(8)}</span>
              <span className="h-3 text-[10.5px]" style={{ color: dd ? (dd > 0 ? C.green : C.red) : K.faint }}>{dd == null ? "" : dd ? `${dd > 0 ? "▲" : "▼"}${Math.abs(dd)}` : "±0"}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
function TimeView({ g, ds }: { g: Goal; ds: Day[] }) {
  const spent = ds.reduce((s, d) => s + d.usd, 0);
  const total = g.spec.started ? Math.max(1, Math.round((Date.parse(g.spec.deadline) - Date.parse(g.spec.started)) / 86400_000)) : null;
  return (
    <>
      <Big verdict={{ word: g.daysLeft > 0 ? `${g.daysLeft} days left` : "Past the deadline", color: g.daysLeft > 7 ? C.blue : C.amber }} value={`$${spent.toFixed(2)}`} rest="spent so far" sub={`Deadline ${dayLabel(g.spec.deadline)}${total ? ` · day ${total - g.daysLeft} of ${total}` : ""}`} />
      <div className="mt-4 space-y-1">
        {[...ds].reverse().filter((d) => d.run).map((d) => (
          <div key={d.date} className="flex items-center gap-3 text-[13px]">
            <span className="w-14 text-[11.5px]" style={{ fontFamily: "var(--today-mono)", color: K.faint }}>{dayLabel(d.date)}</span>
            <span className="h-2 rounded-full" style={{ width: `${Math.max(2, (d.usd / Math.max(0.01, ...ds.map((x) => x.usd))) * 60)}%`, background: d.usd ? C.blue : "rgba(255,255,255,.1)" }} />
            <span style={{ color: K.muted }}>{d.usd ? `$${d.usd.toFixed(2)}` : "—"}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ── runners: a failed one is a card, the rest one sentence ───────────────────────────────────────────────
const broken = (r: Automation) => r.status === "failing" || r.status === "not-loaded";
function FailedCard({ r, a, act }: { r: Automation; a: Asks & { live: ReturnType<typeof useHandoffLive>; open: (sid: string) => void }; act: AutomationsFeed["act"] }) {
  const v: Verdict = { word: r.status === "not-loaded" ? "Not loaded" : "Failed", color: C.red };
  const [ran, setRan] = useState(false);
  return (
    <div id={`auto-${r.id}`} className="mx-3 mb-2 rounded-2xl p-3.5" style={{ background: tint(C.red, 6), border: `1px solid ${tint(C.red, 40)}` }}>
      <div className="flex items-center gap-2"><Pill v={v} /><span className="truncate text-[12px]" style={{ color: K.faint }}>{[r.project, r.scheduleText].filter(Boolean).join(" · ")}</span></div>
      <p className="mt-2 text-[15px] font-semibold">{r.name}</p>
      {r.lastLine && <p className="mt-0.5 line-clamp-2 text-[12.5px]" style={{ color: K.faint, fontFamily: "var(--today-mono)" }}>{r.lastLine}</p>}
      <AskRows asks={a.asks} live={a.live} kind="runner" id={r.id} onOpen={a.open} />
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Q onClick={() => a.ask("runner", r.id, "Why did it fail?")} busy={a.busy === `runner:${r.id}:Why did it fail?`}>Why did it fail?</Q>
        <Q onClick={async () => { await act({ op: "run", id: r.id }, `run:${r.id}`); setRan(true); }}>{ran ? "Started" : "Run it again"}</Q>
      </div>
    </div>
  );
}
function RunnerRow({ r, a, act }: { r: Automation; a: Asks & { live: ReturnType<typeof useHandoffLive>; open: (sid: string) => void }; act: AutomationsFeed["act"] }) {
  const [open, setOpen] = useState(false);
  const dot = r.status === "running" ? C.amber : r.status === "paused" ? K.faint : C.green;
  const when = r.status === "running" ? "always on" : r.status === "paused" ? "paused" : r.lastRun ? ago(r.lastRun) : "not run yet";
  const pause = async () => {
    // Pausing a protected runner has consequences outside the page (the bot leaves Slack), so it asks first.
    if (r.status !== "paused" && r.protected && !confirm(`Pause “${r.name}”? ${r.description}`)) return;
    await act({ op: r.status === "paused" ? "resume" : "pause", id: r.id }, `pause:${r.id}`);
  };
  return (
    <div id={`auto-${r.id}`} className={open ? "my-1 rounded-xl p-2.5" : ""} style={open ? { background: "rgba(0,0,0,.25)" } : undefined}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2.5 py-[7px] text-left text-[13.5px]">
        <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot, boxShadow: r.status === "running" ? `0 0 0 3px ${tint(C.amber, 25)}` : undefined }} />
        <span className="min-w-0 flex-1 truncate">{r.name}</span>
        <span className="shrink-0 text-[11.5px]" style={{ color: K.faint }}>{when}</span>
      </button>
      {open && (
        <div className="pl-[18px]">
          <p className="text-[12.5px] leading-snug" style={{ color: K.muted }}>{r.description}</p>
          <p className="mt-1 text-[12px]" style={{ color: K.faint }}>{r.scheduleText}{r.nextRun ? ` · next ${new Date(r.nextRun).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</p>
          {r.lastLine && <p className="mt-1 truncate text-[11.5px]" style={{ fontFamily: "var(--today-mono)", color: K.faint }}>{r.lastLine}</p>}
          <AskRows asks={a.asks} live={a.live} kind="runner" id={r.id} onOpen={a.open} />
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Q onClick={() => a.ask("runner", r.id, "What did it do on its last run?")} busy={a.busy === `runner:${r.id}:What did it do on its last run?`}>What did it do last run?</Q>
            {r.kind === "launchd" && r.status !== "running" && <button onClick={() => act({ op: "run", id: r.id }, `run:${r.id}`)} className="h-9 rounded-full px-3.5 text-[13px]" style={{ border: `1px solid ${K.line}`, color: K.muted }}>Run now</button>}
            <button onClick={pause} className="h-9 rounded-full px-3.5 text-[13px]" style={{ border: `1px solid ${K.line}`, color: K.muted }}>{r.status === "paused" ? "Resume" : "Pause"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── the page ─────────────────────────────────────────────────────────────────────────────────────────────
export function PhoneAutopilot({ goals, runners, feed }: { goals: Goal[] | null; runners: Automation[] | null; feed: AutomationsFeed }) {
  const asks = useAsks();
  const openChat = useOpenChat();
  const live = useHandoffLive(asks.asks.map((x) => x.sessionId));
  const a = { ...asks, live, open: openChat };
  // Behind first; the first goal starts at card size and the rest as lines, until he taps one.
  const sorted = useMemo(() => [...(goals ?? [])].sort((x, y) => Number(behind(y)) - Number(behind(x))), [goals]);
  const [size, setSize] = useState<Record<string, "line" | "card">>({});
  const sizeOf = (g: Goal, i: number) => size[g.spec.id] ?? (i === 0 ? "card" : "line");
  const [full, setFull] = useState<{ id: string; m: Metric } | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const fullGoal = full ? sorted.find((g) => g.spec.id === full.id) : undefined;
  const series = useMemo(() => new Map(sorted.map((g) => [g.spec.id, days(g)])), [sorted]);

  const resolve = async (g: Goal) => {
    setResolving(g.spec.id);
    try {
      const r = await fetch("/api/goals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "resolve", id: g.spec.id }) }).then((r) => r.json());
      if (r.error) asks.setToast({ text: r.error, error: true }); else asks.setToast({ text: "Minami is on your part", sid: r.sessionId });
    } catch { asks.setToast({ text: "Couldn't reach the dashboard.", error: true }); }
    finally { setResolving(null); }
  };

  if (!goals || !runners) return <p className="px-5 py-10 text-[14px]" style={{ color: K.faint }}>Loading…</p>;
  const bad = runners.filter(broken), fine = runners.filter((r) => !broken(r));
  const lagging = sorted.filter(behind).length;
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const sentence = [lagging ? `${n(lagging, "goal")} behind` : sorted.length ? "Goals on track" : "", bad.length ? `${n(bad.length, "runner")} failed` : ""].filter(Boolean).join(", ");

  return (
    <div className="pb-28">
      <p className="px-5 pb-3 text-[14px]" style={{ color: K.muted }}>{sentence ? `${sentence}. ` : "All quiet. "}<span style={{ color: K.faint }}>{fine.length} fine.</span></p>
      {sorted.map((g, i) => sizeOf(g, i) === "card"
        ? <div key={g.spec.id} className="mb-2"><GoalCard g={g} ds={series.get(g.spec.id) ?? []} a={a} onShrink={() => setSize((s) => ({ ...s, [g.spec.id]: "line" }))} onMetric={(m) => setFull({ id: g.spec.id, m })} onResolve={() => resolve(g)} resolving={resolving === g.spec.id} /></div>
        : <GoalLine key={g.spec.id} g={g} onGrow={() => setSize((s) => ({ ...s, [g.spec.id]: "card" }))} />)}
      {bad.length > 0 && <p className="px-5 pb-1.5 pt-3 text-[11px] font-semibold tracking-[.09em]" style={{ color: K.faint }}>NEEDS A LOOK</p>}
      {bad.map((r) => <FailedCard key={r.id} r={r} a={a} act={feed.act} />)}
      {fine.length > 0 && (
        <div id="runners" className="mx-3 mt-2 rounded-2xl px-3.5 py-3" style={{ background: tint(C.green, 6), border: `1px solid ${tint(C.green, 20)}` }}>
          <button onClick={() => setAllOpen((v) => !v)} aria-expanded={allOpen} className="flex w-full items-center gap-2 text-left text-[14.5px]">
            <span style={{ color: C.green }}>✓</span><span className="flex-1">{bad.length ? `${n(fine.length, "other")} running fine` : `${n(fine.length, "runner")} running fine`}</span><span style={{ color: K.faint }}>{allOpen ? "⌃" : "›"}</span>
          </button>
          {allOpen && <div className="mt-1.5">{fine.map((r) => <RunnerRow key={r.id} r={r} a={a} act={feed.act} />)}</div>}
        </div>
      )}
      {fullGoal && full && <GoalFull g={fullGoal} ds={series.get(fullGoal.spec.id) ?? []} metric={full.m} setMetric={(m) => setFull({ id: fullGoal.spec.id, m })} onClose={() => setFull(null)} a={asks} />}
      {asks.toast && (
        <div className="fixed inset-x-3 bottom-[calc(76px+env(safe-area-inset-bottom))] z-[90] flex items-center gap-3 rounded-2xl px-3.5 py-3 text-[13.5px] shadow-2xl" style={{ background: "#1f242e", border: `1px solid ${K.line}` }}>
          <span className="min-w-0 flex-1 truncate" style={{ color: asks.toast.error ? C.red : undefined }}>{asks.toast.text}</span>
          {asks.toast.sid && <button onClick={() => { openChat(asks.toast!.sid!); asks.setToast(null); }} className="shrink-0 font-semibold" style={{ color: C.blue }}>Open chat →</button>}
        </div>
      )}
    </div>
  );
}
