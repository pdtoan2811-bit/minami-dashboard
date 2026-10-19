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
//   • Thomas's part as a checklist (ticked on Today, where the heartbeat put it);
//   • "Resolve with Minami", which hands all of the above to a vault chat that can fix what is broken.
// Many goals = the list on the left, behind/broken first.
//
// A failed check is never drawn as a result: "no reading" is its own word, "not on page 1" is not a position.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Goal, GoalAction, GoalRun, Position } from "@/lib/goals";
import type { Automation } from "@/lib/automations";
import { K as TK, Glass } from "../today/ui";
import { STATUS } from "./RunnersSection";
import { useOpenChat } from "@/components/shell/Drawer";

const K = { ...TK, green: "#3ecf8e", amber: "#f3c766", red: "#ff8a8d" };
const mix = (c: string, p: number) => `color-mix(in srgb, ${c} ${p}%, transparent)`;
const MONO = { fontFamily: "var(--today-mono)" } as const;

const posText = (p: Position | undefined) => (p === undefined ? "—" : p === "no reading" ? "No reading" : p === null ? "Not on p.1" : `#${p}`);
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

  return { goals, err, busy, runNow };
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
export function GoalsSection({ goals, total, err, busy, runNow, runnersFor }: {
  goals: Goal[] | null; total: number; err: string; busy: boolean; runNow: () => void; runnersFor: (g: Goal) => Automation[];
}) {
  const sorted = useMemo(() => [...(goals ?? [])].sort((a, b) => rank(a) - rank(b)), [goals]);
  // The selection follows #goal-<id> (the shell's drawer links there), else the most urgent goal.
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    const m = location.hash.match(/^#goal-(.+)$/);
    if (m) setSel(decodeURIComponent(m[1]));
  }, []);
  const g = sorted.find((x) => x.spec.id === sel) ?? sorted[0];
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
        </Glass>
      )}
      {g && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <ul className="space-y-2">
            {sorted.map((x) => <GoalRow key={x.spec.id} g={x} on={x === g} onPick={() => { setSel(x.spec.id); history.replaceState(null, "", `#goal-${x.spec.id}`); }} />)}
          </ul>
          <GoalDetail key={g.spec.id} g={g} busy={busy || g.runner.running} onRun={runNow} runners={runnersFor(g)} />
        </div>
      )}
    </div>
  );
}

function GoalRow({ g, on, onPick }: { g: Goal; on: boolean; onPick: () => void }) {
  const last = g.log.at(-1), h = health(g);
  const asks = g.today ? g.today.todos.filter((t) => !t.done).length + g.today.questions.length : 0;
  return (
    <li>
      <button onClick={onPick} className="w-full rounded-2xl px-4 py-3 text-left transition-colors hover:bg-white/[0.06]"
        style={{ background: on ? mix(K.accentBright, 9) : "rgba(255,255,255,.04)", border: `1px solid ${on ? K.accentBright : K.line}` }}>
        <div className="flex items-center gap-2">
          {last ? <Pill color={last.decision.on_track ? K.green : K.amber}>{last.decision.on_track ? "On track" : "Behind"}</Pill> : <Pill color={K.faint}>Not run</Pill>}
          {h.tone === "bad" && <Pill color={K.red}>Runner issue</Pill>}
          <span className="ml-auto text-[11.5px]" style={{ ...MONO, color: K.faint }}>{g.daysLeft >= 0 ? `${g.daysLeft}d left` : `${-g.daysLeft}d past`}</span>
        </div>
        <p className="mt-1.5 text-[13.5px] font-semibold leading-snug">{g.spec.goal}</p>
        <p className="mt-1 text-[11.5px]" style={{ color: K.faint }}>{g.note}{asks ? <> · <span style={{ color: K.accentBright }}>{asks} for you</span></> : null}</p>
      </button>
    </li>
  );
}

function GoalDetail({ g, busy, onRun, runners }: { g: Goal; busy: boolean; onRun: () => void; runners: Automation[] }) {
  const last = g.log.at(-1);
  const q = g.spec.target.queries;
  const ranked = q.map((x) => last?.positions[x]).filter((p): p is number => typeof p === "number");
  const spent = g.log.reduce((s, r) => s + (r.usd || 0), 0), paid = g.log.filter((r) => r.usd).length;
  const h = health(g);
  const openChat = useOpenChat();
  const [resolving, setResolving] = useState(false);
  const [rerr, setRerr] = useState("");
  const [more, setMore] = useState(false);

  const resolve = async () => {
    setResolving(true); setRerr("");
    try {
      const r = await fetch("/api/goals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "resolve", id: g.spec.id }) }).then((r) => r.json());
      if (r.error) setRerr(r.error); else openChat(r.sessionId);
    } catch { setRerr("Couldn't reach the dashboard."); }
    finally { setResolving(false); }
  };

  return (
    // The id is the shell's "Needs you" target (/autopilot#goal-<id>); Glass takes no id, hence the wrapper.
    <div id={`goal-${g.spec.id}`} className="min-w-0 scroll-mt-6">
      <Glass className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] tracking-[.08em]" style={{ ...MONO, color: K.faint }}>
              <a href={obsidian(`10-19 Projects/${g.note}`)} style={{ color: K.faint }}>{g.note.toUpperCase()}</a>
              {g.spec.started && <> · STARTED {short(g.spec.started).toUpperCase()}</>}
            </div>
            <h2 className="mt-1 text-[19px] font-semibold leading-snug tracking-tight">{g.spec.goal}</h2>
            <p className="mt-1 text-[12.5px]" style={{ color: K.faint }}>Done when: {g.spec.done_when}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* The chat is the way to ACT on what this card shows: the page can only say a goal is stuck. */}
            <button onClick={resolve} disabled={resolving} title="Send this goal's runs, failures and your part to a Minami chat that fixes what it can"
              className="rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-opacity disabled:opacity-50"
              style={{ background: "rgba(255,255,255,.07)", border: `1px solid ${K.line2}`, color: K.ink }}>{resolving ? "Starting…" : "Resolve with Minami"}</button>
            <button onClick={onRun} disabled={busy} className="rounded-full px-3.5 py-1.5 text-[13px] font-semibold text-white transition-opacity disabled:opacity-50"
              style={{ background: K.accent }}>{busy ? "Running…" : "Run now"}</button>
          </div>
        </div>
        {rerr && <p className="mt-2 text-[12.5px]" style={{ color: K.red }}>{rerr}</p>}

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat k="Position" v={ranked.length ? `#${Math.min(...ranked)}` : last ? posText(last.positions[q[0]]) : "—"} s={`${q.length > 1 ? "best of " + q.length + " queries" : `“${q[0]}”`} · target #${g.spec.target.value}`} />
          <Stat k="Indexed" v={last?.index ? `${last.index.indexed} / ${last.index.total}` : "—"} s="pages in Google" />
          <Stat k="Days left" v={String(Math.max(0, g.daysLeft))} s={`deadline ${short(g.spec.deadline)}`} />
          <Stat k="Spent" v={`$${spent.toFixed(2)}`} s={`${paid} paid run${paid === 1 ? "" : "s"}`} />
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-[12.5px]"
          style={{ background: mix(TONE[h.tone], 12), border: `1px solid ${mix(TONE[h.tone], 35)}` }}>
          <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full" style={{ background: TONE[h.tone] }} />
          <span><b>Runner:</b> <span style={{ color: K.muted }}>{h.text}</span></span>
          {runners.length > 0 && <span className="ml-auto hidden shrink-0 sm:inline" style={{ ...MONO, color: K.faint }}>{runners.map((a) => a.scheduleText).join(" · ")}</span>}
        </div>

        {last && <p className="mt-4 text-[13.5px] leading-relaxed" style={{ color: K.muted }}>{last.decision.assessment}</p>}

        <Ledger g={g} />
        <YourPart g={g} />

        <button onClick={() => setMore((v) => !v)} className="mt-5 text-[12.5px]" style={{ ...MONO, color: K.faint }}>
          {more ? "▾" : "▸"} Page 1 today · runners · rules
        </button>
        {more && <More g={g} runners={runners} />}
      </Glass>
    </div>
  );
}

function Stat({ k, v, s }: { k: string; v: string; s: string }) {
  return (
    <div className="rounded-2xl px-3.5 py-3" style={{ background: "rgba(255,255,255,.045)", border: `1px solid ${K.line}` }}>
      <Label>{k}</Label>
      <div className="mt-0.5 text-[20px] font-bold tabular-nums">{v}</div>
      <div className="text-[11.5px]" style={{ color: K.faint }}>{s}</div>
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
      <div className="mt-2 overflow-x-auto">
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
                {q.map((x) => <td key={x} style={{ color: typeof r.positions[x] === "number" ? K.ink : K.muted }}>{posText(r.positions[x])}</td>)}
                <td style={MONO}>{r.index ? `${r.index.indexed}/${r.index.total}` : "—"}</td>
                <td>
                  {r.actions.length ? r.actions.map((a, i) => {
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
                  }) : <span style={{ color: K.faint }}>measured only</span>}
                </td>
                <td className="text-right" style={MONO}>{r.usd ? `$${r.usd.toFixed(2)}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function YourPart({ g }: { g: Goal }) {
  const t = g.today;
  if (!t || (!t.todos.length && !t.questions.length)) return null;
  const min = t.todos.filter((x) => !x.done).reduce((s, x) => s + (x.est_min || 0), 0);
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between">
        <Label>{`Your part today${min ? ` · ${min} min` : ""}`}</Label>
        {/* Ticked on Today: the heartbeat copied these there, and Today is where the tick is stored. */}
        <Link href="/today" className="text-[12px]" style={{ ...MONO, color: K.accentBright }}>Tick on Today →</Link>
      </div>
      <ul className="mt-2 space-y-2">
        {t.todos.map((x) => (
          <li key={x.text} className="flex gap-3 rounded-2xl px-4 py-3 text-[13.5px] leading-snug" style={{ background: "rgba(255,255,255,.04)", border: `1px solid ${K.line}` }}>
            <span className="mt-[2px] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] text-[11px]"
              style={{ border: `1.5px solid ${x.done ? K.green : K.line2}`, background: x.done ? mix(K.green, 25) : "transparent", color: K.green }}>{x.done ? "✓" : ""}</span>
            <span className="min-w-0 flex-1" style={{ color: x.done ? K.faint : K.ink, textDecoration: x.done ? "line-through" : undefined }}>
              {x.text}
              {x.why && <span className="mt-0.5 block text-[12px]" style={{ color: K.faint, textDecoration: "none" }}>{x.why}</span>}
            </span>
            {x.est_min ? <span className="shrink-0 text-[12px]" style={{ color: K.faint }}>{x.est_min}m</span> : null}
          </li>
        ))}
        {t.questions.map((x) => (
          <li key={x.question} className="rounded-2xl px-4 py-3 text-[13.5px]" style={{ background: mix(K.amber, 10), color: K.amber }}>
            Question for you: {x.question} <span style={{ color: K.faint }}>— answer it on Today</span>
          </li>
        ))}
      </ul>
    </div>
  );
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
              <Label>{`“${q}” · ${last.positions[q] === null ? "page 1 without us" : "above us"}`}</Label>
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

const Label = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[11.5px] tracking-[.08em]" style={{ ...MONO, color: K.faint }}>{String(children).toUpperCase()}</div>
);
const Pill = ({ color, children }: { color: string; children: React.ReactNode }) => (
  <span className="rounded-full px-2 py-0.5 text-[11.5px] font-medium" style={{ background: mix(color, 16), color }}>{children}</span>
);
