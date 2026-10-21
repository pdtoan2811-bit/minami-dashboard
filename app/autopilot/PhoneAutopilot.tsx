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
//
// 2026-10-21, after the Scoreboard and Day strip picks: the card's four tiles became the Scoreboard's rows (a rank is
// a number, #55 or 100+, with ▲/▼ vs yesterday and vs 7 days, read from ranks.jsonl), and the runners became the day
// running top to bottom (DayStrip.tsx's PhoneDay) — a runner that needs a look opens as its card where it sits.
import { CountDelta, days, type Day, PageBars, RankLine, ScoreDeltas, headline, rankScores, rankText, useScoreCards } from "./Scoreboard";
import { PhoneDay, dayOf, daySentence, lookOf } from "./DayStrip";
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

// ── the goal's numbers, one point per day ────────────────────────────────────────────────────────────────
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
    const rows = rankScores(g).map((x) => x.now?.rank).filter((r): r is number => typeof r === "number");
    if (rows.length) nums.splice(0, nums.length, ...rows);
    if (nums.length && Math.min(...nums) <= g.spec.target.value) return { word: "On target", color: C.green };
    if (nums.length) return { word: `Ranking #${Math.min(...nums)}`, color: last.decision.on_track ? C.blue : C.amber };
    return { word: "100+", color: C.amber };
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
function GoalCard({ g, a, onShrink, onMetric, onResolve, resolving }: {
  g: Goal; a: Asks & { live: ReturnType<typeof useHandoffLive>; open: (sid: string) => void };
  onShrink: () => void; onMetric: (m: Metric) => void; onResolve: () => void; resolving: boolean;
}) {
  const v = verdict(g);
  const trouble = machineTrouble(g);
  const cards = useScoreCards(g);
  const todo = g.today?.todos.find((t) => !t.done);
  const ranking = v.word === "100+";
  const qs = [ranking ? "Why no rank yet?" : "What moved this week?", "What do I do this week?", "Report"];
  const ask = (s: string) => a.ask("goal", g.spec.id, s === "Report" ? "Write me a short report on this goal: where it stands, what changed day by day, and what's next." : s);
  return (
    <div id={`goal-${g.spec.id}`} className="mx-3 rounded-[18px] p-3.5" style={{ background: `linear-gradient(160deg, ${tint(C.blue, 14)}, rgba(255,255,255,.03))`, border: `1px solid ${tint(C.blue, 30)}` }}>
      {/* Tapping the header shrinks the card back to its line: the same thing you tapped to grow it. */}
      <button onClick={onShrink} className="block w-full text-left" aria-label="Shrink">
        <span className="flex items-center gap-2"><Pill v={v} /><span className="ml-auto truncate text-[12px]" style={{ color: K.faint }}>Goal · {g.note}</span><span className="text-[13px]" style={{ color: K.faint }}>⌃</span></span>
        <span className="mt-2 block text-[19px] font-semibold leading-snug">{headline(g)}</span>
        <span className="mt-0.5 block text-[14px] leading-snug" style={{ color: K.muted }}>{g.spec.goal} · {Math.max(0, g.daysLeft)} days left</span>
      </button>
      {trouble && <p className="mt-2 flex items-start gap-2 text-[13.5px]" style={{ color: "#f0c08a" }}><i className="mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: C.amber }} />{trouble}</p>}
      {/* The Scoreboard's rows: the number on the right, its change under it, its line under that. Tap = full screen. */}
      <div className="mt-3 space-y-2">
        {cards.ranks.map((sc) => (
          <button key={sc.key} onClick={() => onMetric("rank")} className="block w-full rounded-2xl px-3.5 py-3 text-left active:bg-white/[0.08]" style={{ background: "rgba(0,0,0,.24)" }}>
            <span className="flex items-baseline gap-2"><i className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: sc.color }} /><span className="min-w-0 flex-1 truncate text-[15px]" style={{ color: K.muted }}>{sc.label}</span><b className="text-[28px] font-bold leading-none tabular-nums">{rankText(sc.now)}</b></span>
            <span className="mt-1.5 flex flex-wrap gap-1.5"><ScoreDeltas s={sc} /></span>
            <span className="mt-2 block"><RankLine series={sc.series} color={sc.color} h={44} /></span>
          </button>
        ))}
        {cards.pages && (
          <button onClick={() => onMetric("indexed")} className="block w-full rounded-2xl px-3.5 py-3 text-left active:bg-white/[0.08]" style={{ background: "rgba(0,0,0,.24)" }}>
            <span className="flex items-baseline gap-2"><i className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: C.green }} /><span className="flex-1 text-[15px]" style={{ color: K.muted }}>Pages in Google</span><b className="text-[28px] font-bold leading-none tabular-nums">{cards.pages.value}<i className="not-italic text-[15px] font-medium" style={{ color: K.faint }}>/{cards.pages.total}</i></b></span>
            <span className="mt-1.5 flex flex-wrap gap-1.5"><CountDelta v={cards.pages.dayDelta} label="1 day" /><CountDelta v={cards.pages.weekDelta} label="7 days" /></span>
            <span className="mt-2 block"><PageBars days={cards.pages.days} h={34} /></span>
          </button>
        )}
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
        {metric === "rank" && <RankView g={g} qi={qi} setQi={setQi} />}
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
// One keyword, full screen: its number, its change, and every day of ranks.jsonl as a line and a list — the mini
// database itself, readable. #1 at the top; 100+ on the floor; a day with no line (failed or not run) is a gap.
function RankView({ g, qi, setQi }: { g: Goal; qi: number; setQi: (i: number) => void }) {
  const all = rankScores(g, 60), sc = all[qi] ?? all[0];
  if (!sc) return null;
  const rows = g.ranks.filter((r) => r.keyword === sc.key).sort((a, b) => b.date.localeCompare(a.date));
  const v: Verdict = typeof sc.now?.rank === "number" ? (sc.now.rank <= g.spec.target.value ? { word: "On target", color: C.green } : { word: `#${sc.now.rank}`, color: C.amber }) : { word: sc.now ? "100+" : "No reading yet", color: C.red };
  return (
    <>
      {all.length > 1 && <div className="mb-3 flex gap-1.5">{all.map((x, i) => <button key={x.key} onClick={() => setQi(i)} className="h-8 rounded-full px-3 text-[13px]" style={i === qi ? { background: tint(C.blue, 22), color: "#fff" } : { background: "rgba(255,255,255,.05)", color: K.muted }}>{x.label}</button>)}</div>}
      <Big verdict={v} value={rankText(sc.now)} rest={`→ goal #${g.spec.target.value}`} sub={`${sc.label} · ${rows.length} day${rows.length === 1 ? "" : "s"} on record`} />
      <div className="mt-2 flex flex-wrap gap-1.5"><ScoreDeltas s={sc} /></div>
      <div className="mt-4"><RankLine series={sc.series} color={sc.color} h={180} /></div>
      <p className="mt-5 text-[10.5px] font-semibold tracking-[.09em]" style={{ color: K.faint }}>DAY BY DAY · ranks.jsonl</p>
      {rows.slice(0, 30).map((r) => (
        <div key={r.date} className="flex items-baseline gap-3 py-1.5 text-[14px]">
          <span className="w-14 shrink-0 text-[12px]" style={{ fontFamily: "var(--today-mono)", color: K.faint }}>{dayLabel(r.date)}</span>
          <b className="w-14 tabular-nums">{rankText(r)}</b>
          <span className="min-w-0 truncate text-[12.5px]" style={{ color: K.faint }}>read {r.read}{r.url ? ` · ${r.url.replace(/^https?:\/\//, "")}` : ""}</span>
        </div>
      ))}
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

// ── runners: the day, top to bottom ──────────────────────────────────────────────────────────────────────
/** A runner opened where it sits in the day: what it does, its schedule, its last line, and what you can do. A
 *  runner that needs a look leads with why, in amber. */
function RunnerOpen({ r, a, act }: { r: Automation; a: Asks & { live: ReturnType<typeof useHandoffLive>; open: (sid: string) => void }; act: AutomationsFeed["act"] }) {
  const look = lookOf(r);
  const [ran, setRan] = useState(false);
  const pause = async () => {
    // Pausing a protected runner has consequences outside the page (the bot leaves Slack), so it asks first.
    if (r.status !== "paused" && r.protected && !confirm(`Pause “${r.name}”? ${r.description}`)) return;
    await act({ op: r.status === "paused" ? "resume" : "pause", id: r.id }, `pause:${r.id}`);
  };
  const q = look ? "Why does it need a look?" : "What did it do on its last run?";
  return (
    <div id={`auto-${r.id}`} className="rounded-2xl p-3.5" style={look ? { background: tint(C.amber, 7), border: `1px solid ${tint(C.amber, 35)}` } : { background: "rgba(0,0,0,.25)" }}>
      {look && <><b className="block text-[28px] leading-none" style={{ color: C.amber }}>{look.big}</b><p className="mt-2 text-[14.5px] leading-snug">{look.why}</p></>}
      {!look && r.description && <p className="text-[14px] leading-snug" style={{ color: K.muted }}>{r.description}</p>}
      <p className="mt-1.5 text-[13px]" style={{ color: K.faint }}>{[r.project, r.scheduleText].filter(Boolean).join(" · ")}{r.nextRun ? ` · next ${new Date(r.nextRun).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</p>
      {r.lastLine && <p className="mt-1 truncate text-[12px]" style={{ fontFamily: "var(--today-mono)", color: K.faint }}>{r.lastLine}</p>}
      <AskRows asks={a.asks} live={a.live} kind="runner" id={r.id} onOpen={a.open} />
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Q onClick={() => a.ask("runner", r.id, q)} busy={a.busy === `runner:${r.id}:${q}`}>{look ? "Why?" : "What did it do last run?"}</Q>
        {r.kind === "launchd" && r.status !== "running" && r.schedule.kind !== "always" && <button onClick={async () => { await act({ op: "run", id: r.id }, `run:${r.id}`); setRan(true); }} className="h-9 rounded-full px-3.5 text-[13px]" style={{ border: `1px solid ${K.line}`, color: K.muted }}>{ran ? "Started" : "Run now"}</button>}
        <button onClick={pause} className="h-9 rounded-full px-3.5 text-[13px]" style={{ border: `1px solid ${K.line}`, color: K.muted }}>{r.status === "paused" ? "Resume" : "Pause"}</button>
      </div>
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
  const [openRunner, setOpenRunner] = useState<string | null>(null);
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
  const day = dayOf(runners);
  const lagging = sorted.filter(behind).length;
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  // A runner that needs a look starts open, where it sits in the day; tapping any other one opens it instead.
  const opened = openRunner ?? day.looks[0]?.a.id ?? null;

  return (
    <div className="pb-28">
      {lagging > 0 && <p className="px-5 pb-2 text-[14.5px]" style={{ color: K.muted }}>{n(lagging, "goal")} behind.</p>}
      {sorted.map((g, i) => sizeOf(g, i) === "card"
        ? <div key={g.spec.id} className="mb-2"><GoalCard g={g} a={a} onShrink={() => setSize((s) => ({ ...s, [g.spec.id]: "line" }))} onMetric={(m) => setFull({ id: g.spec.id, m })} onResolve={() => resolve(g)} resolving={resolving === g.spec.id} /></div>
        : <GoalLine key={g.spec.id} g={g} onGrow={() => setSize((s) => ({ ...s, [g.spec.id]: "card" }))} />)}
      <div id="runners" className="mt-5">
        <p className="px-5 pb-2 text-[17px] font-semibold leading-snug">{daySentence(day)}</p>
        <PhoneDay day={day} open={opened} onPick={(id) => setOpenRunner(opened === id ? "" : id)} renderOpen={(r) => <RunnerOpen r={r} a={a} act={feed.act} />} />
      </div>
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
