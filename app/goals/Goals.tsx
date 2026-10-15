"use client";
// The Goals page (§29): each autonomous goal, read top to bottom as — where it stands right now (one big number
// per target query, against the target), the road to the deadline (one cell per day, coloured by that day's
// reading), why the runner thinks so, what's left for Thomas today, what the runner did, and the rules it runs by.
// Borrows /automations' look so the three pages (Today, Automations, Goals) read as one place.
//
// A failed check is never drawn as a result: "no reading" is hatched, "not on page 1" is a flat dim cell, and
// only a measured position gets a colour — the same rule the runner's log keeps.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Goal, GoalAction, GoalRun, Position } from "@/lib/goals";
import { inter, interVi, mono } from "../today/fonts";

const K = {
  bg: "#0b0e12", paper: "#161b23", ink: "#ffffff", muted: "rgba(255,255,255,.68)", faint: "rgba(255,255,255,.45)",
  line: "rgba(255,255,255,.12)", line2: "rgba(255,255,255,.22)", accent: "#346aff", accentBright: "#90aeff",
  green: "#3ecf8e", amber: "#f3c766", red: "#ff8a8d",
};
const mix = (c: string, p: number) => `color-mix(in srgb, ${c} ${p}%, transparent)`;
const MONO = { fontFamily: "var(--today-mono)" } as const;
const HATCH = `repeating-linear-gradient(135deg, ${K.line2} 0 2px, transparent 2px 5px)`;

// #1 is the goal, page-one top three is close, the rest of page one is moving, off page one is flat.
const posColor = (p: Position | undefined) =>
  typeof p !== "number" ? null : p === 1 ? K.green : p <= 3 ? K.accentBright : K.amber;
const posText = (p: Position | undefined) =>
  p === undefined ? "—" : p === "no reading" ? "No reading" : p === null ? "Not on page 1" : `#${p}`;

const dayList = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T12:00:00`); t <= Date.parse(`${to}T12:00:00`); t += 864e5) out.push(new Date(t).toLocaleDateString("en-CA"));
  return out;
};
const short = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const obsidian = (note: string) => `obsidian://open?vault=secondBrain&file=${encodeURIComponent(note)}`;

export function Goals() {
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

  return (
    <div className={`${inter.variable} ${interVi.variable} ${mono.variable} min-h-dvh`} style={{ fontFamily: "var(--today-sans), var(--today-sans-vi), ui-sans-serif, system-ui", color: K.ink, background: K.bg }}>
      <div className="mx-auto max-w-[860px] px-5 pb-28 pt-10">
        <div className="mb-1 text-[12px]" style={MONO}><Link href="/today" style={{ color: K.faint }}>← Today</Link></div>
        <h1 className="text-[30px] font-semibold tracking-tight">Goals</h1>
        <p className="mt-1 text-[14.5px]" style={{ color: K.muted }}>Targets an agent works on every morning at 06:45. Your part lands on Today.</p>
        {err && <p className="mt-4 rounded-lg px-3 py-2 text-[13px]" style={{ background: mix(K.red, 14), color: K.red }}>{err}</p>}
        {!goals && !err && <p className="pt-24 text-center text-sm" style={{ color: K.muted }}>Loading…</p>}
        {goals?.length === 0 && (
          <p className="mt-10 rounded-xl p-5 text-[14px] leading-relaxed" style={{ background: K.paper, color: K.muted }}>
            No goals yet. A goal is a <code style={MONO}>```json goal</code> block in a note in <code style={MONO}>10-19 Projects/</code> — see the
            note <b style={{ color: K.ink }}>Autonomous Goal Spec</b> in the vault.
          </p>
        )}
        {goals?.map((g) => <GoalCard key={g.spec.id} g={g} busy={busy || g.runner.running} onRun={runNow} />)}
      </div>
    </div>
  );
}

function GoalCard({ g, busy, onRun }: { g: Goal; busy: boolean; onRun: () => void }) {
  const last = g.log.at(-1);
  const prev = g.log.at(-2);
  const behind = last && !last.decision.on_track;
  const [rules, setRules] = useState(false);
  return (
    <section className="mt-8 rounded-2xl p-5 sm:p-6" style={{ background: K.paper, border: `1px solid ${K.line}` }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11.5px] tracking-[.08em]" style={{ ...MONO, color: K.faint }}>
            <a href={obsidian(`10-19 Projects/${g.note}`)} style={{ color: K.faint }}>{g.note.toUpperCase()}</a>
          </div>
          <h2 className="mt-1 text-[20px] font-semibold leading-snug tracking-tight">{g.spec.goal}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px]" style={{ color: K.muted }}>
            <span>Deadline {short(g.spec.deadline)} · <b style={{ color: K.ink }}>{g.daysLeft >= 0 ? `${g.daysLeft} days left` : `${-g.daysLeft} days past`}</b></span>
            {last && <Pill color={behind ? K.amber : K.green}>{behind ? "Behind" : "On track"}</Pill>}
            {g.runner.running && <Pill color={K.accentBright}>Running now</Pill>}
            {!g.runner.loaded && <Pill color={K.red}>Runner not loaded</Pill>}
          </div>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <button onClick={onRun} disabled={busy}
            className="rounded-lg px-3 py-1.5 text-[13px] font-medium transition-opacity disabled:opacity-50"
            style={{ background: K.accent, color: K.ink }}>{busy ? "Running…" : "Run now"}</button>
          <span className="text-[11.5px]" style={{ ...MONO, color: K.faint }}>{last ? `last ${last.date === new Date().toLocaleDateString("en-CA") ? "" : `${short(last.date)} `}${clock(last.at)}` : "never run"} · next 06:45</span>
        </div>
      </div>

      {/* Where it stands: one number per target query. */}
      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {g.spec.target.queries.map((q) => {
          const p = last?.positions[q];
          const before = prev?.positions[q];
          const gsc = last?.gsc?.[q];
          const c = posColor(p);
          return (
            <div key={q} className="min-w-0 rounded-xl p-4" style={{ background: c ? mix(c, 9) : "rgba(255,255,255,.03)", border: `1px solid ${c ? mix(c, 35) : K.line}` }}>
              <div className="text-[12px]" style={{ ...MONO, color: K.faint }}>Google · “{q}”</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className={typeof p === "number" ? "text-[34px] font-semibold tracking-tight" : "text-[20px] font-semibold"} style={{ color: c ?? K.ink }}>{posText(p)}</span>
                <span className="text-[13px]" style={{ color: K.faint }}>target #{g.spec.target.value}</span>
                <Trend now={p} before={before} />
              </div>
              <div className="mt-1 text-[12.5px]" style={{ color: K.muted }}>
                {gsc ? `Search Console: avg #${gsc.position.toFixed(1)} · ${gsc.impressions} impressions · ${gsc.clicks} clicks` : "Search Console: no impressions yet"}
              </div>
              {last?.above?.[q]?.length ? (
                <div className="mt-3 text-[12px]" style={{ color: K.faint }}>
                  <div style={MONO}>{p === null ? "PAGE 1 WITHOUT US" : "ABOVE US"}</div>
                  <ol className="mt-1 space-y-0.5">
                    {last.above[q].slice(0, 3).map((a, i) => <li key={i} className="truncate" style={{ color: K.muted }}><span style={MONO}>{i + 1}.</span> {a}</li>)}
                  </ol>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <Road g={g} />

      {last && (
        <div className="mt-5">
          <Label>Where it stands</Label>
          <p className="mt-1.5 text-[14px] leading-relaxed" style={{ color: K.muted }}>{last.decision.assessment}</p>
          {last.index && (
            <p className="mt-1.5 text-[12.5px]" style={{ ...MONO, color: K.faint }}>
              Indexed {last.index.indexed} of {last.index.total} pages{last.index.failed ? ` · ${last.index.failed} check(s) failed` : ""}
            </p>
          )}
        </div>
      )}

      <YourPart g={g} />
      <Did log={g.log} />

      <button onClick={() => setRules((v) => !v)} className="mt-5 text-[12.5px]" style={{ ...MONO, color: K.faint }}>
        {rules ? "▾" : "▸"} Rules it runs by
      </button>
      {rules && (
        <div className="mt-2 grid gap-4 text-[13px] sm:grid-cols-2" style={{ color: K.muted }}>
          <div>
            <Label>May do</Label>
            <ul className="mt-1.5 space-y-1.5">{Object.entries(g.spec.levers).map(([k, v]) => <li key={k}><b style={{ color: K.ink }}>{k}</b> — {v}</li>)}</ul>
          </div>
          <div>
            <Label>Never</Label>
            <ul className="mt-1.5 list-disc space-y-1 pl-4">{g.spec.never.map((n) => <li key={n}>{n}</li>)}</ul>
            <div className="mt-3"><Label>Asks you when</Label></div>
            <ul className="mt-1.5 list-disc space-y-1 pl-4">{g.spec.escalate.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
        </div>
      )}
    </section>
  );
}

// The road to the deadline: one cell per day per query, so a week of "not on page 1" reads as a flat line and
// the first coloured cell is the moment it moved.
function Road({ g }: { g: Goal }) {
  const start = g.spec.started || g.log[0]?.date || new Date().toLocaleDateString("en-CA");
  const days = useMemo(() => dayList(start, g.spec.deadline), [start, g.spec.deadline]);
  const byDay = useMemo(() => { const m = new Map<string, GoalRun>(); for (const r of g.log) m.set(r.date, r); return m; }, [g.log]);
  const today = new Date().toLocaleDateString("en-CA");
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Label>{`Road to ${short(g.spec.deadline)}`}</Label>
        <Legend />
      </div>
      <div className="mt-2 space-y-1.5">
        {g.spec.target.queries.map((q) => (
          <div key={q} className="flex items-center gap-2">
            <span className="w-[86px] shrink-0 truncate text-[11.5px]" style={{ ...MONO, color: K.faint }}>{q}</span>
            <div className="grid flex-1 gap-[3px]" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
              {days.map((d) => {
                const r = byDay.get(d);
                const p = r?.positions[q];
                const c = posColor(p);
                const future = d > today;
                const bg = !r ? "transparent" : p === "no reading" ? HATCH : c ?? K.line2;
                return (
                  <div key={d} title={`${short(d)} — ${r ? posText(p) : future ? "to come" : "no run"}`}
                    className="h-[18px] rounded-[4px]"
                    style={{ background: bg, border: `1px solid ${d === today ? K.accentBright : future || !r ? K.line : "transparent"}` }} />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between pl-[94px] text-[11px]" style={{ ...MONO, color: K.faint }}>
        <span>{short(days[0])}</span><span>{short(days.at(-1)!)}</span>
      </div>
    </div>
  );
}

function Legend() {
  const item = (bg: string, label: string) => (
    <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: bg }} />{label}</span>
  );
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]" style={{ color: K.faint }}>
      {item(K.green, "#1")}{item(K.accentBright, "#2–3")}{item(K.amber, "#4+")}{item(K.line2, "not on page 1")}{item(HATCH, "no reading")}
    </div>
  );
}

function YourPart({ g }: { g: Goal }) {
  const t = g.today;
  if (!t || (!t.todos.length && !t.questions.length)) return null;
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between">
        <Label>Your part today</Label>
        <Link href="/today" className="text-[12px]" style={{ ...MONO, color: K.accentBright }}>Open Today →</Link>
      </div>
      <ul className="mt-2 space-y-2">
        {t.todos.map((x) => (
          <li key={x.text} className="flex gap-2.5 text-[14px] leading-snug">
            <span className="mt-[3px] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] text-[11px]"
              style={{ border: `1.5px solid ${x.done ? K.green : K.line2}`, background: x.done ? mix(K.green, 25) : "transparent", color: K.green }}>{x.done ? "✓" : ""}</span>
            <span style={{ color: x.done ? K.faint : K.ink, textDecoration: x.done ? "line-through" : undefined }}>
              {x.text}
              {x.why && <span className="mt-0.5 block text-[12.5px]" style={{ color: K.faint, textDecoration: "none" }}>{x.why}</span>}
            </span>
          </li>
        ))}
        {t.questions.map((q) => (
          <li key={q.question} className="rounded-lg px-3 py-2 text-[13.5px]" style={{ background: mix(K.amber, 10), color: K.amber }}>
            Question for you: {q.question} <span style={{ color: K.faint }}>— answer it on Today</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function actionLine(a: GoalAction): { text: string; href?: string; quiet?: boolean; bad?: boolean } | null {
  if (a.lever === "article" && a.queued) return { text: `Queued an article: “${a.queued}”` };
  if (a.lever === "draft" && a.note) return { text: `Drafted for you: ${a.note}`, href: obsidian(`10-19 Projects/goal-drafts/${a.note}`) };
  if (a.lever === "seo-pr" && a.opened) return { text: `Opened a PR: ${a.opened.replace(/^https:\/\/github\.com\//, "")}`, href: a.opened };
  if (a.lever === "merge" && a.merged && a.pr) return { text: `Merged ${a.pr.replace(/^https:\/\/github\.com\//, "")}`, href: a.pr };
  if (a.lever === "merge" && a.waiting && a.pr) return { text: `PR waiting — ${a.waiting}`, href: a.pr, quiet: true };
  if (a.error || a.refused_by_guard) return { text: `${a.lever}: ${a.refused_by_guard ? "refused by the path guard" : a.error}`, bad: true };
  if (a.skipped) return { text: `${a.lever} skipped — ${a.skipped}`, quiet: true };
  return null;
}

function Did({ log }: { log: GoalRun[] }) {
  if (!log.length) return null;
  const runs = [...log].reverse().slice(0, 10);
  const usdWeek = log.filter((r) => Date.now() - Date.parse(r.at) < 7 * 864e5).reduce((s, r) => s + (r.usd || 0), 0);
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between">
        <Label>What it did</Label>
        <span className="text-[11.5px]" style={{ ...MONO, color: K.faint }}>measured spend, 7 days: ${usdWeek.toFixed(2)}</span>
      </div>
      <ol className="mt-2 space-y-2.5">
        {runs.map((r) => {
          const lines = r.actions.map(actionLine).filter((x): x is NonNullable<ReturnType<typeof actionLine>> => !!x);
          return (
            <li key={r.at} className="flex gap-3 text-[13.5px]">
              <span className="w-[54px] shrink-0 pt-px text-[12px]" style={{ ...MONO, color: K.faint }}>{short(r.date)}</span>
              <div className="min-w-0 space-y-0.5">
                {lines.length ? lines.map((l, i) => (
                  <div key={i} style={{ color: l.bad ? K.red : l.quiet ? K.faint : K.muted }}>
                    {l.href ? <a href={l.href} target="_blank" rel="noreferrer" className="underline decoration-white/20 underline-offset-2 hover:decoration-white/60">{l.text}</a> : l.text}
                  </div>
                )) : <div style={{ color: K.faint }}>Measured only.</div>}
                {r.todos.length > 0 && <div style={{ color: K.faint }}>{r.todos.length} to-do{r.todos.length > 1 ? "s" : ""} for you</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Trend({ now, before }: { now: Position | undefined; before: Position | undefined }) {
  if (typeof now !== "number" && typeof before !== "number") return null;
  if (typeof now === "number" && before === null) return <span className="text-[12.5px]" style={{ color: K.green }}>new on page 1</span>;
  if (now === null && typeof before === "number") return <span className="text-[12.5px]" style={{ color: K.red }}>fell off page 1</span>;
  if (typeof now !== "number" || typeof before !== "number" || now === before) return null;
  return now < before
    ? <span className="text-[12.5px]" style={{ color: K.green }}>▲ {before - now}</span>
    : <span className="text-[12.5px]" style={{ color: K.red }}>▼ {now - before}</span>;
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[11.5px] tracking-[.08em]" style={{ ...MONO, color: K.faint }}>{String(children).toUpperCase()}</div>
);
const Pill = ({ color, children }: { color: string; children: React.ReactNode }) => (
  <span className="rounded-full px-2 py-0.5 text-[11.5px] font-medium" style={{ background: mix(color, 16), color }}>{children}</span>
);
