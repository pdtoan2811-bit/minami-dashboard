"use client";
// The Today page (§26), dressed as ecvision's onboarding (/setup): a golden-hour sky with glass panes,
// one frosted card, pill buttons, a mono eyebrow. Two modes:
//   • the day   — a short headline, the to-dos by focus (titles only; tap one for detail and hand-off),
//                 research and the log folded away.
//   • decide    — the open questions one per screen, exactly like onboarding's questions step: tap an
//                 answer and it moves on. Under the answers: let Minami decide, or ask a teammate.
// Every hand-off starts a dashboard chat server-side and links to it at /?open=<id>.
// Colours are ecvision's dark-ground kit tokens (kit.css, origin/develop 2026-10-12), not approximations.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { TodayDay, TodayTodo, TodayLoop } from "@/lib/today";
import { inter, interVi, mono } from "./fonts";

// ── tokens (kit.css: [data-ground="dark"] + [data-brand="ecvision"] dark) ───────────────────────────
const K = {
  bg: "#0b0e12", paper: "#161b23", ink: "#ffffff", muted: "rgba(255,255,255,.68)", faint: "rgba(255,255,255,.45)",
  line: "rgba(255,255,255,.12)", line2: "rgba(255,255,255,.22)", accent: "#346aff", accentBright: "#90aeff", accent2: "#6fe3ff",
  cat1: "#2985f0", cat3: "#c38400", cat4: "#db6393", cat6: "#ec3a3e",
};
const mix = (c: string, p: number, onto = "transparent") => `color-mix(in srgb, ${c} ${p}%, ${onto})`;
const EASE = "cubic-bezier(.22,.61,.21,1)";
const FOCUS: Record<string, { label: string; color: string }> = {
  seo: { label: "SEO", color: K.accent2 }, video: { label: "Video", color: K.cat4 }, other: { label: "Other", color: K.faint },
};
const fkey = (f?: string) => (f && FOCUS[f] ? f : "other");
const localDateClient = () => new Date().toLocaleDateString("en-CA");
// Same window as runHeartbeat() and the heartbeat's own guard: past it, a "running" day is a dead run.
const STALL_MS = 20 * 60e3;
const hhmm = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const eyebrowDate = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).toUpperCase();
const plain = (s: string) => s.replace(/\s*\(Recommended\)\s*$/i, "");
const isRec = (s: string) => /\(Recommended\)\s*$/i.test(s);
// A plan written before titles existed only has `text`: take its first sentence, turn draft slugs into
// words ("`2026-10-08-black-friday-checklist`" → "black friday checklist") and cut at a word boundary.
const human = (s: string) => s.replace(/`(?:\d{4}-\d{2}-\d{2}-)?([^`]+)`/g, (_, x: string) => x.replace(/[-_]+/g, " "));
const firstSentence = (s: string) => (s.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? s);
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/[\s,;:]+\S*$/, "") + "…" : s);
const titleOf = (t: TodayTodo) => t.title || cut(human(firstSentence(t.text)).replace(/\s*\([^)]*\)/g, "").replace(/[.]$/, ""), 64);
type Member = { key: string; name: string; role?: string };

// `backticks` from the heartbeat → inline code
function Inline({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/g).map((p, i) => p.length > 2 && p.startsWith("`") && p.endsWith("`")
    ? <code key={i} className="rounded px-1 py-px text-[0.88em]" style={{ fontFamily: "var(--today-mono)", background: "rgba(255,255,255,.08)" }}>{p.slice(1, -1)}</code> : p)}</>;
}

// ── page ─────────────────────────────────────────────────────────────────────────────────────────
export function Today() {
  const [day, setDay] = useState<TodayDay | null>(null);
  const [today, setToday] = useState("");
  const [days, setDays] = useState<string[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [deciding, setDeciding] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [toast, setToast] = useState<{ text: string; href?: string } | null>(null);
  const [heroGone, setHeroGone] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const heroRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    new IntersectionObserver(([e]) => setHeroGone(!e.isIntersecting), { threshold: 0 }).observe(el);
  }, []);

  // Every load and save takes a ticket; only the newest may land. Focus and visibilitychange both fire a
  // GET, and an older one landing after a tick's POST would visibly undo it — or a poll landing after
  // go(past) would snap the page back to today under a URL that names the past date.
  const seq = useRef(0);
  const dayRef = useRef<TodayDay | null>(null);
  dayRef.current = day;
  // The device's own date when the page last loaded: the rollover checks compare against this, never
  // against the server's date, because phone and Mac can sit in different zones.
  const loadedOn = useRef("");
  const load = useCallback(async (d?: string | null): Promise<boolean> => {
    const n = ++seq.current;
    let r;
    try { r = await fetch(`/api/today${d ? `?date=${d}` : ""}`, { cache: "no-store" }).then((r) => r.json()); }
    catch { r = null; }
    if (n !== seq.current) return false;
    if (r?.day) { setDay(r.day); setDays(r.days); setToday(r.today); loadedOn.current = localDateClient(); setLoadErr(null); return true; }
    // A failed first load (server still warming up at login, a bad ?date=) must offer a retry, not hang.
    // With a day on screen loadErr isn't rendered, so a failed switch says so in the toast instead.
    const text = r ? r.error || "Couldn't load that day." : "Couldn't reach the dashboard.";
    if (dayRef.current) setToast({ text }); else setLoadErr(text);
    return false;
  }, []);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    load(q.get("date"));
    if (q.get("decide")) setDeciding(true);
    fetch("/api/team/roster").then((r) => r.json()).then((r) => setMembers(r.members || [])).catch(() => {});
  }, [load]);
  useEffect(() => {
    if (day?.status !== "running") return;
    const started = Date.parse(day.started_at || "0");
    // Stop once the run is stale (a killed heartbeat never writes its end state) instead of polling forever.
    // The last tick loads once more: `stalled` is computed at render, and without a fresh day nothing
    // re-renders, so a focused tab would never show "Heartbeat stalled — rebuild".
    const t = setInterval(() => { if (Date.now() - started > STALL_MS) { clearInterval(t); load(day.date); } else load(day.date); }, 8000);
    return () => clearInterval(t);
  }, [day?.status, day?.date, day?.started_at, load]);
  // Refresh on return: the 09:00 agent opens a new tab daily and the old ones stay open. A stale tab
  // would act on old state, and one left overnight would write this morning's edits into yesterday.
  const date = day?.date;
  useEffect(() => {
    const f = () => {
      if (document.visibilityState !== "visible" || !date) return;
      const rolled = date === today && localDateClient() !== loadedOn.current;
      load(rolled ? null : date).then((ok) => { if (ok && rolled) history.replaceState(null, "", "/today"); });
    };
    addEventListener("focus", f); document.addEventListener("visibilitychange", f);
    return () => { removeEventListener("focus", f); document.removeEventListener("visibilitychange", f); };
  }, [date, today, load]);
  // The auto-tick (vault bin/today-sync.mjs, every 10 min) writes the day file behind the page's back;
  // a visible tab looks again every minute so a tick shows up without a reload. Hidden tabs don't poll.
  useEffect(() => {
    if (!date) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") load(date); }, 60_000);
    return () => clearInterval(t);
  }, [date, load]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 9000); return () => clearTimeout(t); }, [toast]);

  const act = useCallback(async (body: Record<string, unknown>) => {
    // A tab left visible overnight may never see focus or visibilitychange (display sleep fires
    // neither), so check here too: an edit after midnight would land in yesterday, which carry has
    // already passed over. Decide pins its own date, so it isn't caught by this. Midnight is the
    // device's own, measured against its clock at load time: comparing the phone's date with the Mac's
    // refused every edit while the two zones disagreed. The server's date is still the only one written.
    if (body.date === undefined && day && day.date === today && localDateClient() !== loadedOn.current) {
      load(null).then((ok) => { if (ok) history.replaceState(null, "", "/today"); });
      const error = "It's a new day — reloaded. Try that again."; // as the error too: handoff() toasts r.error
      setToast({ text: error });
      return { error };
    }
    seq.current++; // a GET started before this save must not overwrite the day it returns
    // A dropped fetch (phone on Tailscale) or a 400 must say so; callers keep typed text until r.day.
    let r;
    try { r = await fetch("/api/today", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: day?.date, ...body }) }).then((r) => r.json()); }
    catch { r = null; }
    if (!r || r.error) {
      const error = r?.error || "Couldn't save — check the connection.";
      setToast({ text: error });
      return { ...r, error };
    }
    if (r.day) setDay(r.day);
    return r;
  }, [day, today, load]);

  const handoff = useCallback(async (kind: "todo" | "loop", id: string, how: "do" | "decide" | "ask", extra: Record<string, unknown> = {}) => {
    const r = await act({ op: "handoff", kind, id, how, ...extra });
    if (r.ok) setToast({ text: how === "ask" ? `Sending to ${(extra.member as Member)?.name} — Minami is writing the card.` : "Minami is on it.", href: `/?open=${r.sessionId}` });
    else setToast({ text: r.error || "Couldn't start the chat." });
    return r;
  }, [act]);

  if (!day) return <Ground>{loadErr
    ? <div className="flex flex-col items-center gap-3 pt-32 text-center text-sm" style={{ color: K.muted }}>
        <p>{loadErr}</p>
        <TextButton onClick={() => { setLoadErr(null); load(new URLSearchParams(location.search).get("date")); }}>Retry</TextButton>
      </div>
    : <p className="pt-32 text-center text-sm" style={{ color: K.muted }}>Loading…</p>}</Ground>;

  const isToday = day.date === today;
  const idx = days.indexOf(day.date);
  // The URL follows only a load that landed, or a failed switch would leave it naming the wrong day.
  const go = (d?: string) => { if (!d) return; load(d).then((ok) => { if (ok) history.replaceState(null, "", d === today ? "/today" : `/today?date=${d}`); }); };
  const open = day.loops.filter((l) => !l.resolved && !l.handoff);
  const done = day.todos.filter((t) => t.done).length;
  const shown = day.todos.filter((t) => filter === "all" || fkey(t.focus) === filter);
  const stalled = day.status === "running" && Date.now() - Date.parse(day.started_at || "0") > STALL_MS;
  // Not status: his first edit on a plan-less day flips "none" to "ready" with built_at still null, and
  // the hero must keep offering the build (minami-open.sh only checks that the file exists).
  const planned = !!day.built_at || day.status === "running";

  return (
    <Ground>
      <TopBar right={<>
        <button onClick={() => go(days[idx + 1])} disabled={idx < 0 || !days[idx + 1]} aria-label="Previous day" className="px-1.5 disabled:opacity-25">‹</button>
        {!isToday && <button onClick={() => go(today)} className="hover:text-white">Today</button>}
        <button onClick={() => go(days[idx - 1])} disabled={idx <= 0} aria-label="Next day" className="px-1.5 disabled:opacity-25">›</button>
        <Link href="/" className="ml-2 hover:text-white">Board</Link>
      </>} />

      <main className="mx-auto flex w-full max-w-[620px] flex-col gap-4 px-4 pb-40 pt-2">
        {/* hero */}
        <Glass className="flex flex-col items-center gap-5 px-6 py-7 text-center sm:px-9">
          <Pills n={Math.max(day.todos.length, 1)} filled={done} max={9} />
          <Eyebrow>{eyebrowDate(day.date)}{day.status === "ready" && day.built_at ? ` · PLANNED ${hhmm(day.built_at)}` : ""}</Eyebrow>
          {!planned && <Title size="m">{isToday ? "No plan yet." : day.status === "none" ? "Nothing was recorded." : "No plan was built."}</Title>}
          {day.status === "running" && !day.headline && <Title size="m">Reading your pipelines…</Title>}
          {day.headline && (() => {
            const lead = firstSentence(day.headline), rest = day.headline.slice(lead.length).trim();
            return <><Title size="m"><Inline text={lead} /></Title>
              {rest && <p className="-mt-2 max-w-[440px] text-[14.5px] leading-snug" style={{ color: K.muted }}><Inline text={rest} /></p>}</>;
          })()}
          {day.status === "facts-only" && <p className="text-[13px]" style={{ color: K.cat3 }}>The model step failed, so this list comes straight from disk.</p>}
          <div className="flex w-full flex-col items-center gap-2.5">
            {open.length > 0 && <PillButton tone="accent" cap onClick={() => setDeciding(true)}>{open.length === 1 ? "Answer 1 decision" : `Answer ${open.length} decisions`}</PillButton>}
            {isToday && (!planned
              ? <PillButton tone="accent" cap onClick={() => act({ op: "heartbeat" }).then((r) => { if (!r.error) setTimeout(() => load(day.date), 1500); })}>Build today's plan</PillButton>
              : <TextButton onClick={() => act({ op: "heartbeat" }).then((r) => { if (r.error) return; /* act toasted it; reloading day.date would undo a rollover */ setToast({ text: r.started ? "Rebuilding — about 4 minutes. This page refreshes itself." : `Not started: ${r.reason}` }); setTimeout(() => load(day.date), 1500); })}
                  disabled={day.status === "running" && !stalled}>{day.status === "running" ? (stalled ? "Heartbeat stalled — rebuild" : "Heartbeat running…") : "Rebuild plan"}</TextButton>)}
          </div>
        </Glass>
        <div ref={heroRef} className="-mt-4 h-px" />{/* below the hero's button: once this scrolls off, the sticky one appears */}

        {/* focus */}
        {day.todos.length > 0 && (
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:justify-center">
            {["all", "seo", "video", "other"].map((f) => {
              const ts = f === "all" ? day.todos : day.todos.filter((t) => fkey(t.focus) === f);
              if (f !== "all" && !ts.length) return null;
              return <Chip key={f} on={filter === f} onClick={() => setFilter(f)} dot={f === "all" ? undefined : FOCUS[f].color}>
                {f === "all" ? "All" : FOCUS[f].label} <span className="tabular-nums" style={{ opacity: .6 }}>{ts.filter((t) => t.done).length}/{ts.length}</span></Chip>;
            })}
          </div>
        )}
        {filter !== "all" && day.focus.find((f) => f.id === filter) &&
          <p className="px-2 text-center text-[13px] leading-snug" style={{ color: K.muted }}><Inline text={day.focus.find((f) => f.id === filter)!.status} /></p>}

        {/* to-dos */}
        {(day.todos.length > 0 || isToday) && (
          <Glass className="overflow-hidden">
            <ul>{shown.map((t, i) => <TodoRow key={t.id} t={t} first={i === 0}
              onToggle={() => act({ op: "toggle", id: t.id, done: !t.done })} onRemove={() => act({ op: "remove", id: t.id })}
              onDo={() => handoff("todo", t.id, "do")} />)}</ul>
            <AddTodo first={!shown.length} onAdd={(text) => act({ op: "add", text, focus: filter === "all" ? "other" : filter })} />
          </Glass>
        )}

        {/* answered / handed-off decisions */}
        {day.loops.some((l) => l.resolved || l.handoff) && (
          <Fold label="Decisions" count={day.loops.filter((l) => l.resolved || l.handoff).length}>
            <ul className="space-y-3">{day.loops.filter((l) => l.resolved || l.handoff).map((l) => (
              <li key={l.id} className="text-[13.5px] leading-snug">
                <p style={{ color: K.muted }}>{l.question}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-semibold">{l.handoff?.how === "ask" ? `Asked ${l.handoff.to}` : [].concat((l.resolved?.answer ?? "") as never).map(plain).join(", ")}</span>
                  {l.handoff && <Link href={`/?open=${l.handoff.sessionId}`} className="text-[12.5px]" style={{ color: K.accentBright }}>Open chat →</Link>}
                  {!l.handoff && <button className="text-[12.5px]" style={{ color: K.accentBright }} onClick={() => handoff("loop", l.id, "decide", { answer: l.resolved?.answer })}>Hand to Minami →</button>}
                  {/* a handed-off answer belongs to its chat — changing it here would never reach it */}
                  {!l.handoff && <button className="ml-auto text-[12px]" style={{ color: K.faint }} onClick={() => act({ op: "reopen", id: l.id })}>Change</button>}
                </div>
              </li>))}</ul>
          </Fold>
        )}

        {day.research.length > 0 && (
          <Fold label="Research this morning" count={day.research.length}>
            <ul className="space-y-3.5">{day.research.map((r, i) => (
              <li key={i} className="text-[13.5px] leading-snug">
                <a href={r.url} target="_blank" rel="noreferrer" className="font-semibold underline decoration-white/25 underline-offset-[3px] hover:decoration-white/70">{r.title}</a>
                <p className="mt-1" style={{ color: K.muted }}>{r.takeaway}</p>
              </li>))}</ul>
          </Fold>
        )}

        <Fold label="Log" count={day.log.length}>
          <NoteBox onNote={(text) => act({ op: "note", text })} />
          <ul className="mt-3 space-y-2">{[...day.log].reverse().map((e, i) => (
            <li key={i} className="flex gap-3 text-[13px] leading-snug">
              <span className="shrink-0 tabular-nums" style={{ color: K.faint, fontFamily: "var(--today-mono)", fontSize: 11, paddingTop: 2 }}>{hhmm(e.at)}</span>
              <span style={{ color: e.kind === "note" ? K.ink : K.muted }}>{e.text}</span>
            </li>))}</ul>
        </Fold>
      </main>

      {/* phone: the one thing to do, always in reach */}
      {open.length > 0 && !deciding && heroGone && (
        <div className="fixed inset-x-0 bottom-0 z-20 p-3 sm:hidden" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))", background: `linear-gradient(to top, ${K.bg}, transparent)` }}>
          <PillButton tone="accent" cap onClick={() => setDeciding(true)}>{open.length === 1 ? "Answer 1 decision" : `Answer ${open.length} decisions`}</PillButton>
        </div>
      )}

      {toast && (
        <div className="fixed inset-x-0 bottom-24 z-[60] flex justify-center px-4 sm:bottom-8">
          <div className="flex items-center gap-3 rounded-full px-4 py-2.5 text-[13.5px] shadow-xl" style={{ background: K.paper, border: `1px solid ${K.line2}` }}>
            <span>{toast.text}</span>
            {toast.href && <Link href={toast.href} className="font-semibold" style={{ color: K.accentBright }}>Open chat →</Link>}
          </div>
        </div>
      )}

      {deciding && <Decide loops={open} date={day.date} members={members} onClose={() => { setDeciding(false); load(day.date); }}
        onAnswer={(l, a, d) => act({ op: "resolve", id: l.id, answer: a, date: d })}
        onHandoff={(l, how, extra) => handoff("loop", l.id, how, extra)} />}
    </Ground>
  );
}

// ── the decide flow: onboarding's questions step ─────────────────────────────────────────────────
function Decide({ loops, date, members, onClose, onAnswer, onHandoff }: {
  loops: TodayLoop[]; date: string; members: Member[]; onClose: () => void;
  onAnswer: (l: TodayLoop, a: string, date: string) => Promise<{ error?: string } | undefined>;
  onHandoff: (l: TodayLoop, how: "decide" | "ask", extra?: Record<string, unknown>) => Promise<{ ok?: boolean; sessionId?: string; error?: string }>;
}) {
  // Freeze the list on open: answering removes a loop from `open`, which must not shift the steps.
  const [qs] = useState(loops);
  // …and pin the day: after the overnight rollover the page loads today, but these loops live on the
  // day Decide opened on. Every post names it explicitly (act spreads the body after its own date).
  const [date0] = useState(date);
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<Record<string, string>>({});
  // `answer` is what the server saved; Done's hand-off sends that, never `picked` (which can be a failed tap).
  const [outcome, setOutcome] = useState<Record<string, { label: string; answer?: string | string[]; sessionId?: string }>>({});
  const [other, setOther] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // One answer per step: a double tap (or a repeated key) during the slow POST would resolve the loop
  // twice and advance by two, skipping the next question unseen. `busy` mirrors it for the UI.
  const lock = useRef(false);
  // Each question opens at the top: the scroller keeps its offset across steps otherwise.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [step]);
  const l = qs[step];
  const end = step >= qs.length;
  // Handed off, then Back: the chat owns this answer now (the server refuses a re-answer too).
  const owned = !end && !!outcome[l.id]?.sessionId;

  const release = () => { lock.current = false; setBusy(false); };
  const next = () => { release(); setErr(null); setOther(null); setStep((s) => s + 1); };
  const answer = async (label: string) => {
    if (lock.current) return; lock.current = true; setBusy(true);
    const prev = picked[l.id];
    setPicked((p) => ({ ...p, [l.id]: label }));
    const r = await onAnswer(l, label, date0);
    // A failed tap must not stay lit: Done would otherwise hand the chat an answer that was never saved.
    if (r?.error) {
      setPicked((p) => { const n = { ...p }; if (prev === undefined) delete n[l.id]; else n[l.id] = prev; return n; });
      release(); setErr(r.error); return;
    }
    setOutcome((o) => ({ ...o, [l.id]: { ...o[l.id], label: plain(label), answer: label } }));
    setTimeout(next, 220); // let the accent land before the step changes
  };
  const delegate = async (how: "decide" | "ask", m?: Member) => {
    if (lock.current) return; lock.current = true; setBusy(true); setErr(null);
    const r = await onHandoff(l, how, m ? { member: m, date: date0 } : { date: date0 });
    // A failed hand-off is not settled: say so here (the page's toast sits under this overlay's sky)
    // and leave the question open, or Done would hand a teammate's question to Minami instead.
    if (!r.ok) { release(); setErr(r.error || "Couldn't start the chat."); return; }
    setOutcome((o) => ({ ...o, [l.id]: { label: how === "ask" ? `Asked ${m!.name}` : "Minami decides", sessionId: r.sessionId } }));
    next();
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // Keys typed into "Something else" bubble here too: "2 posts, not 3" must not pick option 2.
      const inField = e.target instanceof HTMLElement && !!e.target.closest("input,textarea,[contenteditable=true]");
      if (e.key === "Escape") { if (inField) setOther(null); else onClose(); return; }
      if (inField) return;
      if (!end && !owned && other === null && /^[1-4]$/.test(e.key) && l.options[+e.key - 1]) answer(l.options[+e.key - 1].label);
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  });

  return (
    // Its own ground: an absolute Sky is one viewport tall inside the scroller and scrolls away, showing
    // the page under a tall question. A fixed one covers every offset (nothing here has a transform),
    // and K.bg keeps it opaque if that ever changes.
    <div ref={scroller} className="fixed inset-0 z-50 overflow-y-auto" style={{ background: K.bg }}>
      <Sky fixed />
      <TopBar right={<button onClick={onClose} className="hover:text-white">Finish later</button>} />
      <div className="relative flex min-h-[calc(100dvh-80px)] items-center justify-center px-4 pb-10">
        <Glass className="w-full max-w-[520px] px-6 py-8 sm:px-9" elevated>
          {!end ? (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col items-center gap-4">
                <Pills n={qs.length} current={step} />
                <Eyebrow>{step + 1} OF {qs.length}{l.focus && FOCUS[l.focus] ? ` · ${FOCUS[l.focus].label.toUpperCase()}` : ""}</Eyebrow>
                <Title>{l.question}</Title>
                {l.context && <p className="-mt-1 max-w-[400px] text-center text-[14px] leading-snug" style={{ color: K.muted }}><Inline text={l.context} /></p>}
              </div>

              {other === null ? (
                <div className="flex flex-col gap-2">
                  {l.options.map((o, i) => (
                    <OptionPill key={o.label} on={picked[l.id] === o.label} rec={isRec(o.label)} n={i + 1} disabled={busy || owned}
                      label={plain(o.label)} desc={o.description} onClick={() => answer(o.label)} />
                  ))}
                  <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[13px]" style={{ color: K.muted }}>
                    {!owned && <>
                      <button onClick={() => setOther("")} className="hover:text-white">Something else</button>
                      <span style={{ color: K.line2 }}>·</span>
                    </>}
                    {/* already handed off (then Back): link the chat rather than start a second one */}
                    {owned
                      ? <>
                        <Link href={`/?open=${outcome[l.id].sessionId}`} style={{ color: K.accentBright }}>Open chat →</Link>
                        <span className="w-full text-center text-[12.5px]" style={{ color: K.faint }}>Minami already has this — change it in the chat.</span>
                      </>
                      : <>
                        <button disabled={busy} onClick={() => delegate("decide")} className="hover:text-white">Let Minami decide</button>
                        {members.map((m) => <span key={m.key} className="contents">
                          <span style={{ color: K.line2 }}>·</span>
                          <button disabled={busy} onClick={() => delegate("ask", m)} className="hover:text-white">Ask {m.name}</button></span>)}
                      </>}
                  </div>
                </div>
              ) : (
                <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (other.trim()) answer(other.trim()); }}>
                  <input autoFocus value={other} onChange={(e) => setOther(e.target.value.slice(0, 300))} placeholder="In your own words"
                    className="h-12 w-full rounded-full px-5 text-[15px] outline-none" style={{ background: K.paper, border: `1px solid ${K.line2}`, color: K.ink }} />
                  <PillButton tone="paper" type="submit">{step === qs.length - 1 ? "Save" : "Next"}</PillButton>
                  <button type="button" onClick={() => setOther(null)} className="mt-1 text-[13px]" style={{ color: K.muted }}>Back to the options</button>
                </form>
              )}
              {err && <p className="text-center text-[13px]" style={{ color: K.cat6 }}>{err}</p>}

              <div className="flex justify-between text-[13px]" style={{ color: K.muted }}>
                <button onClick={() => { release(); setErr(null); setOther(null); setStep((s) => Math.max(0, s - 1)); }} disabled={step === 0 || busy} className="hover:text-white disabled:opacity-0">Back</button>
                <button onClick={next} disabled={busy} className="hover:text-white disabled:opacity-40">Skip for now</button>
              </div>
            </div>
          ) : (
            <Done qs={qs} outcome={outcome} onClose={onClose} onHandAll={async () => {
              const failed: string[] = [];
              for (const q of qs) if (outcome[q.id] && !outcome[q.id].sessionId) {
                const r = await onHandoff(q, "decide", { answer: outcome[q.id].answer, date: date0 });
                if (r.ok) setOutcome((o) => ({ ...o, [q.id]: { ...o[q.id], sessionId: r.sessionId } }));
                else failed.push(r.error || "couldn't start the chat");
              }
              return failed.length ? `${failed.length === 1 ? "One didn't" : `${failed.length} didn't`} start: ${failed[0]}` : null;
            }} />
          )}
        </Glass>
      </div>
    </div>
  );
}

function Done({ qs, outcome, onClose, onHandAll }: { qs: TodayLoop[]; outcome: Record<string, { label: string; answer?: string | string[]; sessionId?: string }>; onClose: () => void; onHandAll: () => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answered = qs.filter((q) => outcome[q.id]);
  const waiting = answered.filter((q) => !outcome[q.id].sessionId);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-4">
        <Pills n={qs.length} current={qs.length} />
        <Eyebrow>{answered.length} OF {qs.length} SETTLED</Eyebrow>
        <Title>{answered.length ? "That's settled." : "Nothing settled yet."}</Title>
      </div>
      {answered.length > 0 && (
        <ul className="flex flex-col gap-2">{answered.map((q) => (
          <li key={q.id} className="rounded-[22px] px-5 py-3 text-[13.5px] leading-snug" style={{ background: mix(K.paper, 70), border: `1px solid ${K.line}` }}>
            <p style={{ color: K.muted }}>{q.question}</p>
            <div className="mt-1 flex items-center gap-3"><span className="font-semibold">{outcome[q.id].label}</span>
              {outcome[q.id].sessionId && <Link href={`/?open=${outcome[q.id].sessionId}`} className="ml-auto text-[12.5px]" style={{ color: K.accentBright }}>Open chat →</Link>}</div>
          </li>))}</ul>
      )}
      <div className="flex flex-col items-center gap-2.5">
        {waiting.length > 0 && <PillButton tone="accent" cap disabled={busy} onClick={async () => { setBusy(true); setErr(null); setErr(await onHandAll()); setBusy(false); }}>
          {busy ? "Starting…" : waiting.length === 1 ? "Hand it to Minami" : `Hand all ${waiting.length} to Minami`}</PillButton>}
        {err && <p className="text-center text-[13px]" style={{ color: K.cat6 }}>{err}</p>}
        <PillButton tone="paper" onClick={onClose}>Back to today</PillButton>
      </div>
    </div>
  );
}

// ── rows ─────────────────────────────────────────────────────────────────────────────────────────
function TodoRow({ t, first, onToggle, onRemove, onDo }: { t: TodayTodo; first: boolean; onToggle: () => void; onRemove: () => void; onDo: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const detail = t.text;
  return (
    <li style={{ borderTop: first ? undefined : `1px solid ${K.line}` }}>
      <div className="flex items-center gap-3.5 px-5 py-3.5">
        <button onClick={onToggle} aria-label={t.done ? "Mark not done" : "Mark done"}
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[12px] transition-all active:scale-90"
          style={{ background: t.done ? K.accent : "transparent", border: `1.5px solid ${t.done ? K.accent : K.line2}`, color: "#fff", transitionTimingFunction: EASE }}>{t.done ? "✓" : ""}</button>
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: FOCUS[fkey(t.focus)].color }} />
          <span className={`min-w-0 flex-1 text-[15px] font-medium leading-snug ${t.done ? "line-through" : ""}`} style={{ color: t.done ? K.faint : K.ink, textDecorationColor: K.line2 }}>
            <Inline text={titleOf(t)} /></span>
          {t.handoff && <span className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px]" style={{ background: mix(K.accent, 22), color: K.accentBright, fontFamily: "var(--today-mono)" }}>MINAMI</span>}
          {t.done && t.done_by === "auto" && <span title={t.done_evidence} className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px]" style={{ background: mix(K.cat3, 22), color: "#f3c766", fontFamily: "var(--today-mono)" }}>AUTO</span>}
          {t.est_min ? <span className="shrink-0 tabular-nums" style={{ color: K.faint, fontFamily: "var(--today-mono)", fontSize: 11 }}>{t.est_min}m</span> : null}
          <span className="shrink-0 text-[12px] transition-transform" style={{ color: K.faint, transform: open ? "rotate(90deg)" : "none" }}>›</span>
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-3 pb-4 pl-[56px] pr-5">
          {detail && <p className="text-[13.5px] leading-relaxed" style={{ color: K.muted }}><Inline text={detail} /></p>}
          {t.why && <p className="text-[13px] leading-snug" style={{ color: K.faint }}><Inline text={t.why} /></p>}
          {t.done && t.done_by === "auto" && t.done_evidence && <p className="text-[13px] leading-snug" style={{ color: "#f3c766" }}>Ticked automatically — {t.done_evidence} Untick it if that's wrong; it won't be ticked again.</p>}
          <div className="flex flex-wrap items-center gap-2 text-[11.5px]" style={{ fontFamily: "var(--today-mono)", color: K.faint }}>
            {t.folder && <span className="rounded-full px-2.5 py-1" style={{ background: "rgba(255,255,255,.06)" }}>{t.folder}</span>}
            {t.source === "carried" && <span style={{ color: K.cat3 }}>from yesterday</span>}
            {t.cmd && <button onClick={() => { navigator.clipboard?.writeText(t.cmd!); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
              className="max-w-full truncate rounded-full px-2.5 py-1 text-left hover:text-white" style={{ background: "rgba(255,255,255,.06)" }}>{copied ? "copied" : `$ ${t.cmd}`}</button>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {t.handoff
              ? <Link href={`/?open=${t.handoff.sessionId}`} className="inline-flex"><PillButton tone="paper" small>Open Minami's chat →</PillButton></Link>
              : <PillButton tone="accent" cap small disabled={busy || t.done} onClick={async () => { setBusy(true); await onDo(); setBusy(false); }}>{busy ? "Starting…" : "Do it with Minami"}</PillButton>}
            <button onClick={onRemove} className="ml-auto text-[12.5px] hover:text-white" style={{ color: K.faint }}>Drop</button>
          </div>
        </div>
      )}
    </li>
  );
}

// Both boxes keep the typed text until the save lands: a failed POST must not eat it.
function AddTodo({ first, onAdd }: { first: boolean; onAdd: (text: string) => Promise<{ day?: unknown } | undefined> }) {
  const [text, setText] = useState("");
  return (
    <form onSubmit={async (e) => { e.preventDefault(); const v = text.trim(); if (!v) return; const r = await onAdd(v); if (r?.day) setText(""); }}
      className="flex items-center gap-3.5 px-5 py-3" style={{ borderTop: first ? undefined : `1px solid ${K.line}` }}>
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[15px]" style={{ border: `1.5px dashed ${K.line2}`, color: K.faint }}>+</span>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a to-do"
        className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-white/35" />
    </form>
  );
}

function NoteBox({ onNote }: { onNote: (text: string) => Promise<{ day?: unknown } | undefined> }) {
  const [text, setText] = useState("");
  return (
    <form onSubmit={async (e) => { e.preventDefault(); const v = text.trim(); if (!v) return; const r = await onNote(v); if (r?.day) setText(""); }}>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Log a note"
        className="h-11 w-full rounded-full px-5 text-[14px] outline-none placeholder:text-white/35" style={{ background: mix(K.paper, 80), border: `1px solid ${K.line2}` }} />
    </form>
  );
}

// ── kit-shaped primitives ────────────────────────────────────────────────────────────────────────
function Ground({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${inter.variable} ${interVi.variable} ${mono.variable} relative min-h-dvh`} style={{ fontFamily: "var(--today-sans), var(--today-sans-vi), ui-sans-serif, system-ui", color: K.ink, background: K.bg }}>
      <Sky fixed />
      <div className="relative">{children}</div>
    </div>
  );
}

// The onboarding's golden-hour sky, reduced to what reads at a glance: the base gradient (cat-1 over
// cat-6 on the dark ground), an afterglow, three receding glass panes and film grain.
const GRAIN = `url("data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .55 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>')}")`;
function Sky({ fixed }: { fixed?: boolean }) {
  const panes = useMemo(() => [
    { inset: "14% 9% 9% 11%", rot: -1.6, o: 1 }, { inset: "20% 7% 21% 27%", rot: -0.8, o: .85 }, { inset: "24% 6% 28% 33%", rot: 0, o: .7 },
  ], []);
  return (
    <div aria-hidden className={`${fixed ? "fixed" : "absolute"} inset-0 overflow-hidden`} style={{ background: `linear-gradient(to bottom, ${mix(K.cat1, 24, K.bg)}, ${mix(K.cat6, 16, K.bg)})` }}>
      <div className="absolute inset-x-0 bottom-0 h-[60%]" style={{ background: `radial-gradient(ellipse 50% 50% at 50% 100%, ${mix(K.cat3, 18)} 0%, ${mix(K.cat6, 12)} 40%, transparent 80%)` }} />
      <div className="absolute inset-0 hidden sm:block" style={{ perspective: 1400 }}>
        {panes.map((p, i) => (
          <div key={i} className="absolute rounded-[34px]" style={{ inset: p.inset, opacity: p.o, transform: `rotateY(-9deg) rotateZ(${p.rot}deg)`,
            background: `linear-gradient(155deg, ${mix(K.ink, 12)} 0%, ${mix(K.cat3, 6)} 34%, ${mix(K.cat4, 7)} 62%, ${mix(K.cat1, 8)} 100%)`,
            border: `1px solid ${mix(K.ink, 22)}`, boxShadow: `0 30px 80px rgba(0,0,0,.45)` }} />
        ))}
      </div>
      <div className="absolute inset-0" style={{ backgroundImage: GRAIN, opacity: .08 }} />
    </div>
  );
}

function TopBar({ right }: { right?: React.ReactNode }) {
  return (
    <div className="relative z-10 flex items-center px-5 pb-4 pt-5 sm:px-11 sm:pt-9">
      <Link href="/today" className="text-[17px] font-semibold tracking-tight">Minami</Link>
      <div className="ml-auto flex items-center gap-1 text-[14px]" style={{ color: K.muted }}>{right}</div>
    </div>
  );
}

function Glass({ children, className = "", elevated }: { children: React.ReactNode; className?: string; elevated?: boolean }) {
  return (
    <div className={`rounded-[30px] ${className}`} style={{
      background: `linear-gradient(160deg, ${mix(K.ink, 10)}, ${mix(K.paper, 55)})`, border: `1px solid ${K.line2}`,
      backdropFilter: "blur(22px) saturate(175%)", WebkitBackdropFilter: "blur(22px) saturate(175%)",
      boxShadow: elevated ? "0 24px 70px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.12)" : "0 10px 34px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.08)" }}>
      {children}
    </div>
  );
}

function Pills({ n, current, filled, max = 12 }: { n: number; current?: number; filled?: number; max?: number }) {
  const count = Math.min(n, max);
  return (
    <div className="flex items-center justify-center gap-1.5">
      {Array.from({ length: count }, (_, i) => {
        const on = current !== undefined ? i <= current : i < (filled ?? 0);
        const wide = current !== undefined && i === current;
        return <span key={i} className="h-1 rounded-full transition-all duration-500 motion-reduce:transition-none"
          style={{ width: wide ? 28 : 8, background: on ? K.accent : K.line2 }} />;
      })}
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p style={{ fontFamily: "var(--today-mono)", fontSize: 11, letterSpacing: "0.08em", color: K.muted }}>{children}</p>;
}

function Title({ children, size = "l" }: { children: React.ReactNode; size?: "l" | "m" }) {
  return <h1 className={`text-center font-bold ${size === "l" ? "text-[30px] sm:text-[40px]" : "text-[23px] sm:text-[28px]"}`}
    style={{ lineHeight: size === "l" ? 1.07 : 1.18, letterSpacing: "-0.025em", textWrap: "balance" as never }}>{children}</h1>;
}

function PillButton({ children, tone, cap, small, disabled, onClick, type = "button" }: { children: React.ReactNode; tone: "accent" | "paper"; cap?: boolean; small?: boolean; disabled?: boolean; onClick?: () => void; type?: "button" | "submit" }) {
  const accent = tone === "accent";
  return (
    <button type={type} disabled={disabled} onClick={onClick}
      className={`group relative flex items-center justify-center rounded-full font-semibold transition-all hover:-translate-y-px active:scale-[.98] disabled:pointer-events-none disabled:opacity-50 ${small ? "min-h-[36px] px-4 text-[13.5px]" : "min-h-[46px] w-full px-5 text-[15px]"} ${cap ? (small ? "pr-11" : "pr-12") : ""}`}
      style={{ transitionDuration: "320ms", transitionTimingFunction: EASE, lineHeight: 1.2,
        color: accent ? "#fff" : K.ink, background: accent ? K.accent : K.paper,
        border: `1px solid ${accent ? "transparent" : K.line2}`,
        boxShadow: accent ? `0 0 0 1px ${mix(K.accentBright, 45)}, 0 1px 3px rgba(0,0,0,.2)` : "0 1px 2px rgba(0,0,0,.25)" }}>
      {children}
      {cap && <span className={`absolute right-1.5 flex items-center justify-center rounded-full text-[14px] ${small ? "h-6 w-6" : "h-8 w-8"}`} style={{ background: "rgba(255,255,255,.18)" }}>→</span>}
    </button>
  );
}

function OptionPill({ label, desc, on, rec, n, disabled, onClick }: { label: string; desc?: string; on: boolean; rec: boolean; n: number; disabled?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled} className="group relative w-full rounded-[24px] px-6 py-3 text-center transition-all hover:-translate-y-px active:scale-[.98]"
      style={{ transitionDuration: "320ms", transitionTimingFunction: EASE,
        background: on ? K.accent : K.paper, border: `1px solid ${on ? "transparent" : K.line2}`,
        boxShadow: on ? `0 0 0 1px ${mix(K.accentBright, 45)}, 0 1px 3px rgba(0,0,0,.2)` : "0 1px 2px rgba(0,0,0,.25)" }}>
      <span className="absolute left-5 top-[15px] hidden sm:block" style={{ fontFamily: "var(--today-mono)", fontSize: 10.5, color: on ? "rgba(255,255,255,.7)" : K.faint }}>{n}</span>
      <span className="block text-[15px] font-semibold leading-tight">{label}
        {rec && <span className="ml-2 inline-block -translate-y-px rounded-full px-1.5 py-px align-middle text-[9.5px] font-medium tracking-[0.06em]"
          style={{ fontFamily: "var(--today-mono)", background: on ? "rgba(255,255,255,.2)" : mix(K.accent, 26), color: on ? "#fff" : K.accentBright }}>SUGGESTED</span>}</span>
      {desc && <span className="mt-1 block text-[12.5px] font-normal leading-snug" style={{ color: on ? "rgba(255,255,255,.82)" : K.muted }}>{desc}</span>}
    </button>
  );
}

function Chip({ children, on, dot, onClick }: { children: React.ReactNode; on: boolean; dot?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex shrink-0 items-center gap-2 rounded-full px-3.5 py-2 text-[13.5px] sm:px-4 font-semibold transition-all hover:-translate-y-px"
      style={{ transitionDuration: "320ms", transitionTimingFunction: EASE, background: on ? K.accent : mix(K.paper, 75), border: `1px solid ${on ? "transparent" : K.line2}`, color: K.ink }}>
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: on ? "#fff" : dot }} />}{children}
    </button>
  );
}

function TextButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button onClick={onClick} disabled={disabled} className="text-[13px] hover:text-white disabled:opacity-60" style={{ color: K.muted }}>{children}</button>;
}

function Fold({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Glass className="overflow-hidden">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-5 py-3.5 text-left">
        <span className="text-[15px] font-semibold">{label}</span>
        <span className="tabular-nums" style={{ color: K.faint, fontFamily: "var(--today-mono)", fontSize: 11 }}>{count}</span>
        <span className="ml-auto text-[12px] transition-transform" style={{ color: K.faint, transform: open ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </Glass>
  );
}
