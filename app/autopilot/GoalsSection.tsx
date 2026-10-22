"use client";
// The Goals section of /autopilot (§29, inside §30), as "list + run ledger" — the version Thomas picked from the
// goals-console pitch (2026-10-16). The earlier card answered "where does it stand?" and left "is it working?"
// to a paragraph: no run history in one place, no outcome per action, no cost, and the runner's own failures
// (a guard that refused every PR) read the same as the goal simply being behind.
//
// So, per goal:
//   • four numbers — position, indexed, days left, spent;
//   • the RUNNER's health on its own line, apart from the goal's status: "behind" and "broken" are different news;
//   • a ledger of every run: what it measured, each action with its outcome (done / queued / opened / refused…),
//     and what it cost;
//   • Thomas's part as Today's own to-do rows, ticked right on the card (GoalTodos.tsx; stored on Today);
//   • "Resolve with Minami", which hands all of the above to a vault chat that can fix what is broken. Its chat shows
//     as a row on the card (Asks.tsx); nothing on this page navigates away any more (2026-10-22).
// Many goals = the list on the left, behind/broken first, ending in "Add a goal" (2026-10-22: the list used to
// appear only from the second goal on, so there was nowhere to add one).
//
// A failed check is never drawn as a result: "no reading" is its own word. Since the Scoreboard pick (2026-10-21)
// the detail is: one sentence, the numbers with their change vs yesterday and 7 days, the one thing that needs you,
// and everything above folded behind one click (Scoreboard.tsx has the why).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Goal, GoalAction, GoalRun, Position } from "@/lib/goals";
import type { Automation } from "@/lib/automations";
import { K as TK, Glass } from "../today/ui";
import { STATUS } from "./RunnersSection";
import { AskBox } from "./AskBox";
import { useAsks } from "./Asks";
import { GoalTodos } from "./GoalTodos";
import { GoalDays, PageBars, RankLine, SC, headline, localDate, rankText, useScoreCards, type Score } from "./Scoreboard";

const K = { ...TK, green: "#3ecf8e", amber: "#f3c766", red: "#ff8a8d" };
const mix = (c: string, p: number) => `color-mix(in srgb, ${c} ${p}%, transparent)`;
const MONO = { fontFamily: "var(--today-mono)" } as const;

// A rank is a number (2026-10-21): "#55", or "100+" when it wasn't in the 100 results read — "46+" for the shallower
// checks before that day. Never "not in top N": the N is the check's depth, and beside a rank it read as one.
const posText = (p: Position | undefined, depth = 10) => (p === undefined ? "—" : p === "no reading" ? "no reading" : p === null ? `${depth >= 90 ? 100 : depth}+` : `#${p}`);
const short = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const obsidian = (note: string) => `obsidian://open?vault=secondBrain&file=${encodeURIComponent(note)}`;
const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA");
const today = () => new Date().toLocaleDateString("en-CA");

/** The goals feed, lifted out of the section so /autopilot can match goals to runners and apply the project filter. */
export function useGoals() {
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/goals").then((r) => r.json()).catch((e) => ({ error: String(e) }));
    if (r.error) setErr(r.error); else { setErr(""); setGoals(r.goals); }
  }, []);
  useEffect(() => {
    load();
    const poll = setInterval(() => { if (!document.hidden) load(); }, 20_000);
    return () => clearInterval(poll);
  }, [load]);

  const runNow = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/goals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "run" }) }).then((r) => r.json());
      if (r.error) setErr(r.error); else setGoals(r.goals);
    } finally { setBusy(false); }
  }, []);

  return { goals, err, busy, runNow, reload: load };
}

// ── outcomes ──────────────────────────────────────────────────────────────────────────────────────────────
type Tone = "ok" | "wait" | "bad" | "mute";
const TONE: Record<Tone, string> = { ok: K.green, wait: K.amber, bad: K.red, mute: K.faint };
function outcome(a: GoalAction): { label: string; tone: Tone; what: string; note?: string; href?: string } {
  const gh = (u: string) => u.replace(/^https:\/\/github\.com\//, "");
  if (a.refused_by_guard) return { label: "Refused", tone: "bad", what: lever(a), note: `refused by the path guard: ${a.refused_by_guard.trim()}` };
  if (a.error) return { label: "Failed", tone: "bad", what: lever(a), note: a.error };
  // request-indexing: one row per page, what Search Console answered after the click (gsc-request.mjs).
  if (a.lever === "request-indexing" && a.result) {
    const page = (a.url || "").replace(/^https?:\/\/[^/]+/, "") || "/";
    if (a.result === "requested") return { label: "Requested", tone: "ok", what: `indexing ${page}`, note: "in Google's priority crawl queue" };
    if (a.result === "already indexed") return { label: "Indexed", tone: "mute", what: `indexing ${page}`, note: "already on Google" };
    if (a.result === "quota") return { label: "Waiting", tone: "wait", what: `indexing ${page}`, note: "today's Search Console quota is used" };
    return { label: "Failed", tone: "bad", what: `indexing ${page}`, note: a.result };
  }
  if (a.lever === "merge" && a.merged && a.pr) return { label: "Merged", tone: "ok", what: gh(a.pr), href: a.pr };
  if (a.waiting) return { label: "Waiting", tone: "wait", what: a.pr ? gh(a.pr) : lever(a), note: a.waiting, href: a.pr };
  if (a.opened) return { label: "Opened", tone: "ok", what: `PR ${gh(a.opened)}`, href: a.opened };
  if (a.skipped) return { label: "Skipped", tone: "mute", what: lever(a), note: a.skipped };
  if (a.queued) return { label: "Queued", tone: "wait", what: `article “${a.queued}”`, note: "in the content backlog" };
  if (a.note) return { label: "Done", tone: "ok", what: `draft: ${a.note}`, href: obsidian(`10-19 Projects/goal-drafts/${a.note}`) };
  return { label: "—", tone: "mute", what: lever(a) };
}
const LEVER: Record<string, string> = { "request-indexing": "indexing request", "seo-pr": "SEO change (PR)", article: "article", draft: "draft for you", merge: "merge", todo: "to-do" };
const lever = (a: GoalAction) => LEVER[a.lever] ?? a.lever;

// The runner's health, judged apart from the goal's: a goal can be behind with a healthy runner (it is working,
// the world is slow), or on track with a broken one (a lucky week). Worst first.
function health(g: Goal): { tone: Tone; text: string } {
  const last = g.log.at(-1);
  if (!g.runner.loaded) return { tone: "bad", text: "The runner isn't loaded in launchd — nothing will run until it is." };
  if (g.runner.running) return { tone: "wait", text: "Running now." };
  const broke = last?.actions.filter((a) => a.error || a.refused_by_guard) ?? [];
  if (broke.length) return { tone: "bad", text: `Last run: ${broke.map((a) => `${lever(a)} ${a.refused_by_guard ? "refused by the guard" : "failed"}`).join(", ")}. Nothing it tried landed.` };
  if (g.runner.lastExit != null && g.runner.lastExit !== 0) return { tone: "bad", text: `The last run exited with code ${g.runner.lastExit}.` };
  if (!last) return { tone: "mute", text: "Never run yet." };
  if (Date.now() - Date.parse(last.at) > 30 * 3600e3) return { tone: "bad", text: `No run since ${short(localDay(last.at))} — the daily run was missed.` };
  return { tone: "ok", text: `Ran ${localDay(last.at) === today() ? "today" : short(localDay(last.at))} at ${clock(last.at)}; ${last.actions.length ? "every action landed" : "measured only"}.` };
}

const rank = (g: Goal) => (health(g).tone === "bad" ? 0 : g.log.at(-1)?.decision.on_track === false ? 1 : 2);

/** `goals` arrives already filtered; `total` is the unfiltered count, so "no goals" and "all filtered out" read differently. */
export function GoalsSection({ goals, total, err, busy, runNow, reload, runnersFor, onShown }: {
  goals: Goal[] | null; total: number; err: string; busy: boolean; runNow: () => void; reload: () => void; runnersFor: (g: Goal) => Automation[];
  /** the goal on screen, so the Minami panel is about it */ onShown?: (id: string | null) => void;
}) {
  const sorted = useMemo(() => [...(goals ?? [])].sort((a, b) => rank(a) - rank(b)), [goals]);
  // The selection follows #goal-<id> (the shell's drawer links there), else the most urgent goal.
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    const m = location.hash.match(/^#goal-(.+)$/);
    if (m) setSel(decodeURIComponent(m[1]));
  }, []);
  const g = sorted.find((x) => x.spec.id === sel) ?? sorted[0];
  const shown = g?.spec.id ?? null;
  useEffect(() => { onShown?.(shown); }, [shown, onShown]);
  return (
    <div>
      {err && <p className="mt-4 rounded-lg px-3 py-2 text-[13px]" style={{ background: mix(K.red, 14), color: K.red }}>{err}</p>}
      {!goals && !err && <p className="pt-16 text-center text-sm" style={{ color: K.muted }}>Loading…</p>}
      {goals && total === 0 && (
        <Glass className="mt-4 p-5 text-[14px] leading-relaxed">
          <p style={{ color: K.muted }}>
            No goals yet. A goal is a <code style={MONO}>```json goal</code> block in a note in <code style={MONO}>10-19 Projects/</code> — see the
            note <b style={{ color: K.ink }}>Autonomous Goal Spec</b> in the vault.
          </p>
          <div className="mt-4"><AddGoal /></div>
        </Glass>
      )}
      {/* V4 (2026-10-22): no list column for one goal — it held one card that repeated the headline. From the second
          goal on, the goals are a row of chips above the page; "Add a goal" sits at the foot, its chat in the panel. */}
      {g && <>
        {sorted.length > 1 && (
          <ul className="mb-5 flex flex-wrap gap-2">
            {sorted.map((x) => <GoalRow key={x.spec.id} g={x} on={x === g} onPick={() => { setSel(x.spec.id); history.replaceState(null, "", `#goal-${x.spec.id}`); }} />)}
          </ul>
        )}
        <GoalDetail key={g.spec.id} g={g} busy={busy || g.runner.running} onRun={runNow} onChanged={reload} runners={runnersFor(g)} />
        <div className="mt-10 max-w-[420px]"><AddGoal /></div>
      </>}
    </div>
  );
}

// A new goal is drafted by a chat in the goals module (§31), which follows "Adding a goal" in its AGENTS.md: draft the
// json goal block, show Thomas, write it into the vault note only after he says yes.
function AddGoal() {
  return <AskBox row rows={false} url="/api/modules" body={{ op: "chat", id: "goals", intent: "new" }} field="ask" placeholder="Add a goal" />;
}

function GoalRow({ g, on, onPick }: { g: Goal; on: boolean; onPick: () => void }) {
  const last = g.log.at(-1), h = health(g);
  return (
    <li>
      <button onClick={onPick} className="flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[14px] transition-colors hover:bg-white/[0.06]"
        style={{ background: on ? mix(K.accentBright, 12) : "rgba(255,255,255,.04)", border: `1px solid ${on ? K.accentBright : K.line}` }}>
        <span className="h-2 w-2 rounded-full" style={{ background: h.tone === "bad" ? K.red : !last ? K.faint : last.decision.on_track ? K.green : K.amber }} />
        <span className="font-medium">{g.note}</span>
        <span className="text-[12px]" style={{ ...MONO, color: K.faint }}>{g.daysLeft >= 0 ? `${g.daysLeft}d left` : `${-g.daysLeft}d past`}</span>
      </button>
    </li>
  );
}

function GoalDetail({ g, busy, onRun, onChanged, runners }: { g: Goal; busy: boolean; onRun: () => void; onChanged: () => void; runners: Automation[] }) {
  const h = health(g);
  const { ranks, pages } = useScoreCards(g);
  const q = g.spec.target.queries ?? [];
  const hasPart = !!g.today && (g.today.todos.length > 0 || g.today.questions.length > 0);
  const { reload: reloadAsks } = useAsks();
  const [resolving, setResolving] = useState(false);
  const [rerr, setRerr] = useState("");
  const [more, setMore] = useState(false);

  const resolve = async () => {
    setResolving(true); setRerr("");
    try {
      const r = await fetch("/api/goals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "resolve", id: g.spec.id }) }).then((r) => r.json());
      if (r.error) setRerr(r.error); else reloadAsks(); // the chat appears as a thread in the Minami panel
    } catch { setRerr("Couldn't reach the dashboard."); }
    finally { setResolving(false); }
  };

  const last = g.log.at(-1);
  const verdict = !last ? { t: "Not run yet", c: K.faint } : last.decision.on_track ? { t: "On track", c: K.green } : { t: "Behind", c: K.amber };
  return (
    // The id is the shell's "Needs you" target (/autopilot#goal-<id>).
    // V4 (2026-10-22): no card around the page — it was page → glass card → cards + a column, three frames deep,
    // and the width went on borders. Text stops at reading width; the number row may run wider.
    <div id={`goal-${g.spec.id}`} className="min-w-0 scroll-mt-6">
      <div>
        <div className="text-[13.5px]" style={{ color: K.faint }}>{g.note} · <span style={{ color: verdict.c }}>{verdict.t}</span></div>
        {/* One sentence, the numbers, the one thing that needs you (Shrink · Hide · Embody). */}
        <h2 className="mt-2 max-w-[780px] text-[28px] font-semibold leading-[1.2] tracking-tight">{headline(g)}</h2>
        <p className="mt-1.5 text-[16px]" style={{ color: K.muted }}>
          Goal: #{g.spec.target.value}{q.length > 1 ? " for both" : q.length ? ` for “${q[0]}”` : ""} by {short(g.spec.deadline)}
        </p>
        <div className="mt-4 max-w-[780px]"><GoalDays g={g} /></div>

        {/* One row of numbers: the number big, its change beside it. A line only once it has 7 readings — the rank
            cards were 250 px tall around one or two dots. */}
        <div className="mt-6 grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(1, ranks.length + (pages ? 1 : 0))}, minmax(0, 1fr))` }}>
          {ranks.map((s) => (
            <Tile key={s.key} k={`Rank · ${s.label}`} color={s.color} value={rankText(s.now)} change={rankChange(s)}
              chart={s.series.filter((x) => x !== undefined).length >= 7 ? <RankLine series={s.series} color={s.color} h={30} /> : null}
              note={s.now && s.day !== localDate() ? `as of ${short(s.day!)}` : undefined} />
          ))}
          {pages && (
            <Tile k="Pages in Google" color={SC.green} value={<>{pages.value}{pages.total != null && <small className="ml-1 text-[16px] font-medium" style={{ color: K.faint }}>/ {pages.total}</small>}</>}
              change={countChange(pages.dayDelta, pages.weekDelta)}
              chart={pages.days.filter((d) => d.indexed != null).length >= 7 ? <PageBars days={pages.days} h={30} /> : null} />
          )}
        </div>

        <div className="mt-7 grid items-start gap-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
          {/* His part, as Today's rows: tick, open, comment, "Do it with Minami" — all without leaving the page.
              GoalTodos carries its own heading ("Needs you · 1" / "Your part today — done"). */}
          {hasPart ? <GoalTodos g={g} onChanged={onChanged} />
            : <p className="rounded-2xl px-4 py-3 text-[15px]" style={{ background: "rgba(255,255,255,.04)", color: K.muted }}>Nothing needs you today.</p>}
          <div>
            {/* The RUNNER's health on its own line: "behind" and "broken" are different news (§29). */}
            <div className="flex flex-col gap-3 rounded-2xl px-4 pb-4 pt-3" style={{ background: "rgba(0,0,0,.22)", border: `1px solid ${h.tone === "bad" ? mix(K.red, 40) : K.line}` }}>
              <div className="text-[13px] font-semibold" style={{ color: h.tone === "bad" ? K.red : K.muted }}>The runner</div>
              <div className="-mt-1 flex items-start gap-2.5 text-[14.5px]">
                <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full" style={{ background: TONE[h.tone] }} />
                <span style={{ color: K.muted }}>{h.text}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={onRun} disabled={busy} className="h-9 rounded-full px-3.5 text-[13.5px] font-semibold disabled:opacity-50" style={{ background: "rgba(255,255,255,.07)", border: `1px solid ${K.line2}` }}>{busy ? "Running…" : "Run now"}</button>
                {/* Its chat lands in the Minami panel on the right. */}
                <button onClick={resolve} disabled={resolving} className="h-9 rounded-full px-3.5 text-[13.5px] disabled:opacity-50" style={{ border: `1px solid ${K.line2}`, color: K.muted }}>{resolving ? "Starting…" : "Resolve with Minami"}</button>
              </div>
              {rerr && <p className="text-[13px]" style={{ color: K.red }}>{rerr}</p>}
            </div>
          </div>
        </div>

        <button onClick={() => setMore((v) => !v)} className="mt-6 text-[13.5px]" style={{ ...MONO, color: K.faint }}>
          {more ? "▾" : "▸"} Why it's behind · every run and what it tried · rules · ranks.jsonl
        </button>
        {more && (
          <div>
            {g.log.at(-1) && <p className="mt-4 text-[15px] leading-relaxed" style={{ color: K.muted }}>{g.log.at(-1)!.decision.assessment}</p>}
            <Ledger g={g} />
            <More g={g} runners={runners} />
            {/* Leaves the page by design, so it lives in the fold and says where it goes; the title is no longer a link. */}
            <a href={obsidian(`10-19 Projects/${g.note}`)} className="mt-5 inline-block text-[12.5px] hover:text-white" style={{ ...MONO, color: K.faint }}>Open {g.note} in Obsidian ↗</a>
            {g.ranks.length > 0 && (
              <div className="mt-5">
                <Label>{`ranks.jsonl · ~/.minami/goals/${g.spec.id} · ${g.ranks.length} line${g.ranks.length === 1 ? "" : "s"}`}</Label>
                <div className="mt-2 overflow-hidden rounded-xl p-3 text-[12.5px] leading-relaxed" style={{ ...MONO, background: "rgba(0,0,0,.35)", color: "#b9c6e6" }}>
                  {g.ranks.slice(-14).map((r) => <div key={`${r.date}${r.keyword}`} className="truncate">{JSON.stringify(r)}</div>)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Every run, newest first: what it measured and what each action came to. On a phone the table scrolls inside
// its own box rather than squeezing six columns into 360px.
function Ledger({ g }: { g: Goal }) {
  const q = g.spec.target.queries;
  const runs: GoalRun[] = [...g.log].reverse().slice(0, 14);
  if (!runs.length) return null;
  return (
    <div className="mt-5">
      <Label>Runs</Label>
      {/* Below sm the 580px table scrolls "What it did" off a phone screen: same runs, stacked as cards. */}
      <ul className="mt-2 space-y-2 sm:hidden">
        {runs.map((r) => (
          <li key={r.at} className="rounded-lg px-3 py-2.5 text-[12.5px]" style={{ border: `1px solid ${K.line}` }}>
            <div className="flex items-baseline justify-between gap-3" style={MONO}>
              <span>{short(localDay(r.at))} {clock(r.at)}</span>
              <span style={{ color: K.faint }}>{r.index ? `${r.index.indexed}/${r.index.total} indexed · ` : ""}{r.usd ? `$${r.usd.toFixed(2)}` : "—"}</span>
            </div>
            {q.length ? (
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                {q.map((x) => <span key={x} style={{ color: typeof r.positions[x] === "number" ? K.ink : K.muted }}><span style={{ color: K.faint }}>“{x}”</span> {posText(r.positions[x], r.depth?.[x])}</span>)}
              </div>
            ) : null}
            <div className="mt-2"><RunActions r={r} /></div>
          </li>
        ))}
      </ul>
      <div className="mt-2 hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[580px] text-left text-[12.5px]">
          <thead style={{ color: K.faint }}>
            <tr className="[&>th]:pb-2 [&>th]:pr-3 [&>th]:font-medium">
              <th>When</th>{q.map((x) => <th key={x}>“{x}”</th>)}<th>Indexed</th><th>What it did</th><th className="text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.at} className="align-top [&>td]:border-t [&>td]:border-white/10 [&>td]:py-2.5 [&>td]:pr-3">
                <td className="whitespace-nowrap" style={MONO}>{short(localDay(r.at))} {clock(r.at)}</td>
                {q.map((x) => <td key={x} style={{ color: typeof r.positions[x] === "number" ? K.ink : K.muted }}>{posText(r.positions[x], r.depth?.[x])}</td>)}
                <td style={MONO}>{r.index ? `${r.index.indexed}/${r.index.total}` : "—"}</td>
                <td><RunActions r={r} /></td>
                <td className="text-right" style={MONO}>{r.usd ? `$${r.usd.toFixed(2)}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RunActions({ r }: { r: GoalRun }) {
  if (!r.actions.length) return <span style={{ color: K.faint }}>measured only</span>;
  return <>{r.actions.map((a, i) => {
    const o = outcome(a);
    return (
      <div key={i} className="mb-1 flex items-start gap-2">
        <span className="shrink-0 rounded-full px-2 py-px text-[11px] font-semibold" style={{ background: mix(TONE[o.tone], 20), color: TONE[o.tone] }}>{o.label}</span>
        <span className="min-w-0">
          {o.href ? <a href={o.href} target="_blank" rel="noreferrer" className="underline decoration-white/20 underline-offset-2 hover:decoration-white/60" style={{ color: K.muted }}>{o.what}</a>
            : <span style={{ color: K.muted }}>{o.what}</span>}
          {o.note && <span className="block text-[11.5px]" style={{ color: K.faint }}>{o.note}</span>}
        </span>
      </div>
    );
  })}</>;
}

// What the ledger leaves out: who is ahead on page 1, which automations serve the goal, and its rules.
function More({ g, runners }: { g: Goal; runners: Automation[] }) {
  const last = g.log.at(-1);
  return (
    <div className="mt-3 space-y-5 text-[13px]" style={{ color: K.muted }}>
      {last?.above && (
        <div className="grid gap-3 sm:grid-cols-2">
          {g.spec.target.queries.map((q) => last.above?.[q]?.length ? (
            <div key={q}>
              <Label>{`“${q}” · ${last.positions[q] === null ? "page 1 without us" : "page 1 above us"}`}</Label>
              <ol className="mt-1.5 space-y-0.5">{last.above[q].slice(0, 5).map((a, i) => <li key={i} className="truncate"><span style={MONO}>{i + 1}.</span> {a}</li>)}</ol>
            </div>
          ) : null)}
        </div>
      )}
      {runners.length > 0 && (
        <div>
          <Label>Worked on by</Label>
          <ul className="mt-1.5 flex flex-wrap gap-2">
            {runners.map((a) => (
              <li key={a.id}><a href={`#auto-${a.id}`} className="flex items-center gap-2 rounded-full px-3 py-1 hover:bg-white/5" style={{ border: `1px solid ${K.line}` }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS[a.status].color }} />{a.name}</a></li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div><Label>May do</Label><ul className="mt-1.5 space-y-1.5">{Object.entries(g.spec.levers).map(([k, v]) => <li key={k}><b style={{ color: K.ink }}>{k}</b> — {v}</li>)}</ul></div>
        <div>
          <Label>Never</Label><ul className="mt-1.5 list-disc space-y-1 pl-4">{g.spec.never.map((n) => <li key={n}>{n}</li>)}</ul>
          <div className="mt-3"><Label>Asks you when</Label></div><ul className="mt-1.5 list-disc space-y-1 pl-4">{g.spec.escalate.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      </div>
    </div>
  );
}

// A number tile (V4): label, the number, its change as words beside it, and a small line only once there's a shape.
function Tile({ k, color, value, change, chart, note }: { k: string; color: string; value: React.ReactNode; change: React.ReactNode; chart: React.ReactNode; note?: string }) {
  return (
    <div className="min-w-0 rounded-2xl px-4 py-3.5" style={{ background: "rgba(0,0,0,.25)", border: `1px solid ${K.line}` }}>
      <div className="flex items-center gap-2 text-[13.5px]" style={{ color: K.muted }}><i className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} /><span className="truncate">{k}</span></div>
      <div className="mt-1.5 text-[32px] font-bold leading-none tracking-tight tabular-nums">{value}</div>
      <div className="mt-2 flex items-end justify-between gap-3 text-[13px]"><span className="min-w-0">{change}{note && <span style={{ color: K.faint }}> · {note}</span>}</span>{chart && <span className="w-[90px] shrink-0">{chart}</span>}</div>
    </div>
  );
}
const Up = ({ v, label }: { v: number; label: string }) => <span style={{ color: v > 0 ? K.green : v < 0 ? K.red : K.faint }}>{v === 0 ? `same as ${label}` : `${v > 0 ? "▲" : "▼"} ${Math.abs(v)} vs ${label}`}</span>;
/** A lower rank is better: #55 → #53 is ▲ 2. Not in the results counts as 101. */
function rankChange(s: Score): React.ReactNode {
  if (!s.now) return <span style={{ color: K.faint }}>no reading yet</span>;
  if (s.first) return <span style={{ color: K.faint }}>first reading</span>;
  const from = s.dayBefore ?? s.weekBefore;
  if (!from) return <span style={{ color: K.faint }}>no reading yesterday</span>;
  return <Up v={(from.rank ?? 101) - (s.now.rank ?? 101)} label={s.dayBefore ? "yesterday" : "7 days ago"} />;
}
function countChange(day: number | null, week: number | null): React.ReactNode {
  if (week != null && week !== 0) return <Up v={week} label="7 days ago" />;
  if (day != null) return <Up v={day} label="yesterday" />;
  return <span style={{ color: K.faint }}>no earlier reading</span>;
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[11.5px] tracking-[.08em]" style={{ ...MONO, color: K.faint }}>{String(children).toUpperCase()}</div>
);
const Pill = ({ color, children }: { color: string; children: React.ReactNode }) => (
  <span className="rounded-full px-2 py-0.5 text-[11.5px] font-medium" style={{ background: mix(color, 16), color }}>{children}</span>
);
