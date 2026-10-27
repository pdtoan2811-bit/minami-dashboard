"use client";
// The harness browser (§36): one look answers "is it up, can I log in, what has it been doing".
// Picture first: a 24-hour strip of tab activity with a now-line (the way time reads on Today), then the
// state and the login button, then the visits — one row per tab, the pages it walked through inside it.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { HarnessState, Visit } from "@/lib/harness";
import { K, mix, hhmm, Ground, TopBar, Glass, Eyebrow, PillButton, Chip, Fold } from "../today/ui";

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const pathOf = (u: string) => { try { const p = new URL(u).pathname; return p === "/" ? "" : p; } catch { return ""; } };
const dayOf = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const mins = (a: string, b: string | null) => Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 60000));

function DayStrip({ visits }: { visits: Visit[] }) {
  // Pages opened per hour over the last 24 h, bucketed from the visits' steps.
  const now = Date.now(), from = now - 24 * 3600_000;
  const bins = Array.from({ length: 24 }, () => 0);
  for (const v of visits) for (const s of v.steps) { const t = Date.parse(s.at); if (t >= from) bins[Math.min(23, Math.floor((t - from) / 3600_000))]++; }
  const max = Math.max(1, ...bins), total = bins.reduce((a, b) => a + b, 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2"><span className="text-[28px] font-bold tracking-tight">{total}</span><span className="text-[13px]" style={{ color: K.muted }}>pages in the last 24 h</span></div>
      <div className="relative flex h-14 items-end gap-[3px]">
        {bins.map((n, i) => <div key={i} className="flex-1 rounded-[3px]" title={`${n} page${n === 1 ? "" : "s"}`} style={{ height: n ? `${Math.max(10, (n / max) * 100)}%` : 3, background: n ? K.accentBright : K.line }} />)}
        <div className="absolute inset-y-0 right-0 w-[2px] rounded" style={{ background: K.accent2 }} title="now" />
      </div>
      <div className="flex justify-between text-[10.5px]" style={{ fontFamily: "var(--today-mono)", color: K.faint }}>
        <span>{hhmm(new Date(from).toISOString())}</span><span>{hhmm(new Date(from + 12 * 3600_000).toISOString())}</span><span>now</span>
      </div>
    </div>
  );
}

function VisitRow({ v }: { v: Visit }) {
  const first = v.steps[0], last = v.steps[v.steps.length - 1];
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1 border-t px-4 py-2.5 first:border-t-0" style={{ borderColor: K.line }}>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-3 text-left" disabled={v.steps.length < 2}>
        <span className="w-11 shrink-0 text-[11px]" style={{ fontFamily: "var(--today-mono)", color: K.faint }}>{hhmm(v.start)}</span>
        <img src={`https://www.google.com/s2/favicons?domain=${host(first.url)}&sz=32`} alt="" className="h-4 w-4 shrink-0 rounded" referrerPolicy="no-referrer" />
        <span className="min-w-0 flex-1 truncate text-[13.5px]">
          <b className="font-semibold">{host(last.url)}</b>
          <span style={{ color: K.muted }}> {last.title || pathOf(last.url)}</span>
        </span>
        <span className="shrink-0 text-[11px]" style={{ color: v.open ? K.accent2 : K.faint }}>
          {v.open ? "open" : `${mins(v.start, v.end)} min`}{v.steps.length > 1 ? ` · ${v.steps.length} pages` : ""}
        </span>
      </button>
      {open && <ol className="ml-14 flex flex-col gap-0.5">{v.steps.map((s, i) => (
        <li key={i} className="truncate text-[12px]" style={{ color: K.muted }}>
          <span style={{ fontFamily: "var(--today-mono)", color: K.faint }}>{hhmm(s.at)}</span> {host(s.url)}{pathOf(s.url)}{s.title ? ` — ${s.title}` : ""}
        </li>))}</ol>}
    </div>
  );
}

export function Harness() {
  const [d, setD] = useState<HarnessState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [site, setSite] = useState<string | null>(null);

  const load = useCallback(() => fetch("/api/harness").then((r) => r.json()).then((x) => { setD(x); setErr(null); }).catch(() => setErr("Couldn't read the harness.")), []);
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [load]);

  const post = async (what: "login" | "window", on: boolean) => {
    setBusy(true); setNote(null);
    const r = await fetch(`/api/harness/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(what === "login" ? { on } : { show: on }) }).then((x) => x.json()).catch(() => ({ ok: false, out: "request failed" }));
    setNote(!r.ok ? r.out
      : what === "window" ? (on ? "The harness browser is in front on this Mac. Log in there, then Hide — that saves the logins for the chats too." : "Parked off-screen; logins saved for the chats.")
      : on ? "On this Mac the window is in front; the phone page is starting — give it a few seconds." : "Phone page closed, window parked, logins saved.");
    setBusy(false);
    setTimeout(load, on ? 4000 : 500);
  };

  const sites = useMemo(() => {
    const n = new Map<string, number>();
    for (const v of d?.visits || []) { const h = host(v.steps[0].url); n.set(h, (n.get(h) || 0) + 1); }
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [d]);
  const days = useMemo(() => {
    const g = new Map<string, Visit[]>();
    for (const v of d?.visits || []) if (!site || v.steps.some((s) => host(s.url) === site)) { const k = dayOf(v.start); g.set(k, [...(g.get(k) || []), v]); }
    return [...g.entries()];
  }, [d, site]);

  if (!d) return <Ground><TopBar title="Harness browser" /><p className="pt-24 text-center text-sm" style={{ color: K.muted }}>{err ?? "Loading…"}</p></Ground>;

  return (
    <Ground>
      <TopBar title="Harness browser" />
      <main className="mx-auto flex w-full max-w-[680px] flex-col gap-4 px-4 pb-28 sm:px-0">
        <Glass elevated className="flex flex-col gap-5 p-5">
          <DayStrip visits={d.visits} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: d.up ? "#4ade80" : K.faint }} />{d.up ? `Up · ${d.tabs.length} tab${d.tabs.length === 1 ? "" : "s"} open` : "Down — starts on demand"}</span>
            <span style={{ color: K.faint }}>{d.browser || "Chrome"} · :9333</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PillButton tone="accent" small disabled={busy} onClick={() => post("window", true)}>Show on this Mac</PillButton>
            <PillButton tone="paper" small disabled={busy} onClick={() => post("window", false)}>Hide</PillButton>
            {d.login.up ? <>
              <a href={d.login.url!} target="_blank" rel="noreferrer"><PillButton tone="paper" small>Phone login page ↗</PillButton></a>
              <PillButton tone="paper" small disabled={busy} onClick={() => post("login", false)}>Close phone page</PillButton>
            </> : <PillButton tone="paper" small disabled={busy} onClick={() => post("login", true)}>Log in from phone</PillButton>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Eyebrow>SIGNED IN{d.loginsAt ? ` · SAVED ${hhmm(d.loginsAt)}` : ""}</Eyebrow>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
              {d.logins.length ? d.logins.map((l) => <span key={l.site} style={{ color: l.on ? K.ink : K.faint }}>{l.on ? "✓" : "·"} {l.site}</span>)
                : <span style={{ color: K.faint }}>No saved logins yet — Show on this Mac, log in, then Hide.</span>}
            </div>
            <span className="text-[12px]" style={{ color: K.faint }}>One logged-in browser for everything: scripts, agents and every chat's browser use these logins.</span>
          </div>
          {note && <p className="text-[12.5px]" style={{ color: K.muted }}>{note}</p>}
          {!!d.tabs.length && <div className="flex flex-col gap-1">
            <Eyebrow>OPEN NOW</Eyebrow>
            {d.tabs.map((t, i) => <div key={i} className="truncate text-[13px]"><b className="font-semibold">{host(t.url)}</b> <span style={{ color: K.muted }}>{t.title}</span></div>)}
          </div>}
        </Glass>

        {sites.length > 1 && <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          <Chip on={!site} onClick={() => setSite(null)}>All</Chip>
          {sites.map(([h, n]) => <Chip key={h} on={site === h} onClick={() => setSite(site === h ? null : h)}>{h} · {n}</Chip>)}
        </div>}

        {days.length ? days.map(([day, vs]) => (
          <section key={day} className="flex flex-col gap-2">
            <Eyebrow>{day.toUpperCase()}</Eyebrow>
            <Glass className="overflow-hidden py-1">{vs.map((v) => <VisitRow key={v.id} v={v} />)}</Glass>
          </section>
        )) : <p className="py-8 text-center text-[13.5px]" style={{ color: K.faint }}>
          {d.logStarted ? "Nothing matches." : "No usage logged yet. The harness daemon writes it from its next start (it closes itself after 45 idle minutes)."}
        </p>}

        <Fold label="Browser starts and stops" count={d.marks.length}>
          <div className="flex flex-col gap-0.5 text-[12px]" style={{ fontFamily: "var(--today-mono)", color: K.muted }}>
            {d.marks.map((m, i) => <span key={i}>{dayOf(m.at)} {hhmm(m.at)} · {m.ev === "up" ? "browser up" : m.ev === "down" ? "browser closed" : m.ev === "login" ? `login page opened${m.url ? ` on ${host(m.url)}` : ""}` : "login page closed"}</span>)}
          </div>
        </Fold>
        <Fold label="Daemon log" count={d.daemonLog.length}>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-[14px] p-3 text-[11px]" style={{ background: mix(K.ink, 5), color: K.muted }}>{d.daemonLog.join("\n") || "empty"}</pre>
        </Fold>
        <Fold label="Login page log" count={d.loginLog.length}>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-[14px] p-3 text-[11px]" style={{ background: mix(K.ink, 5), color: K.muted }}>{d.loginLog.join("\n") || "empty"}</pre>
        </Fold>
      </main>
    </Ground>
  );
}
