"use client";
// The runners as TODAY, on one straight line (§27 inside §30) — "T1 · Day strip", the version Thomas picked from the
// autopilot-time pitch (2026-10-21) after he called the 24-hour ring "confusing". The moodboard behind it
// (autopilot-time-mood) counted why: the ring put today's hours and the goal's days on one circle, left the 6 jobs
// without an hour (every 10 min, always on…) off it entirely, drew Sunday jobs on a Wednesday, had unnamed dots, and
// asked him to read angles. So here:
//   • time is a straight line, 00 → 24, with a red now-line; each timed runner is a NAMED pin at its time;
//   • repeating, always-on, at-login and other-weekday runners are rows in the runner table under the strip
//     (RunnersSection, since V4 of the autopilot-layout pitch), so all of them are on screen;
//   • the goal's days are not here at all (Scoreboard's GoalDays);
//   • what needs a look is decided here, once, and drawn as a card by the section (and as an amber pin/track).
// On a phone the same day runs top to bottom (PhoneDay).
import { type ReactNode } from "react";
import type { Automation } from "@/lib/automations";
import { K } from "../today/ui";

export const DC = { green: "#4ade80", amber: "#f0a868", red: "#ef7c7c", blue: "#7aa2ff", grey: "rgba(255,255,255,.35)" };
const tint = (c: string, p: number) => `color-mix(in srgb, ${c} ${p}%, transparent)`;
const MONO = { fontFamily: "var(--today-mono)" } as const;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hm = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const hoursOf = (d: Date) => d.getHours() + d.getMinutes() / 60;
export function dur(sec: number) {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return sec < 36000 && m ? `${h} h ${m} min` : `${Math.round(sec / 3600)} h`;
}

// ── what needs a look ───────────────────────────────────────────────────────────────────────────────────────
export type Look = { big: string; why: string };
/** One rule set for the whole page: failed, off, unfiled, quiet past its period, missed its time, or a partial run. */
export function lookOf(a: Automation, now = new Date()): Look | null {
  if (a.status === "paused") return null;
  // minami-run's reasons (2026-10-30): say what happened instead of a bare exit code.
  const end = a.lastEnd;
  if (end?.reason === "limit" && a.status !== "running")
    return { big: "limit", why: `Hit the Claude limit: “${end.last_line}”. Self-heal re-runs it after the reset if it's safe to repeat; otherwise it's yours to run.` };
  if (a.status === "failing" && end?.reason === "timeout")
    return { big: "too long", why: `Ran ${dur(end.secs ?? 0)}, past its time limit, so it was stopped and the next run can go ahead. Last line: “${end.last_line || "—"}”.` };
  if (a.status === "failing") return { big: `exit ${a.lastExit}`, why: `Its last run failed${a.lastLine ? `: “${a.lastLine}”` : "."}` };
  if (a.status === "not-loaded" && a.kind === "launchd") return { big: "off", why: "launchd isn't holding it, so it won't run until the next login." };
  const since = a.lastRun ? (now.getTime() - Date.parse(a.lastRun)) / 1000 : null;
  if (a.schedule.kind === "every" && since != null && since > Math.max(3 * a.schedule.minutes * 60, 90 * 60)) {
    const missed = Math.floor(since / (a.schedule.minutes * 60)) - 1;
    return { big: dur(since).replace(/ \d+ min$/, ""), why: `Runs every ${a.schedule.minutes} min but hasn't written anything since ${hm(new Date(a.lastRun!))}: about ${missed} runs left no trace.` };
  }
  if (a.schedule.kind === "daily" && a.status !== "running") {
    const [h, m] = a.schedule.at.split(":").map(Number), due = new Date(now); due.setHours(h, m, 0, 0);
    const ranSince = a.lastRun && Date.parse(a.lastRun) >= due.getTime() - 5 * 60e3;
    if (now.getTime() - due.getTime() > 45 * 60e3 && !ranSince && a.lastRun) return { big: "missed", why: `Due at ${a.schedule.at} and hasn't run today. Last run: ${new Date(a.lastRun).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })}.` };
  }
  // "9/10 rendered": a run that exited 0 but did part of its job.
  const part = a.lastLine?.match(/\b(\d+)\s*\/\s*(\d+)\s+(rendered|done|uploaded|ok|passed|succeeded|posted)\b/i);
  if (part && +part[1] < +part[2]) return { big: `${part[1]}/${part[2]}`, why: `Its last run: “${a.lastLine}”.` };
  if (!a.project) return { big: "unfiled", why: `${a.status === "running" ? "Running now, but it" : "It"} has no project or description, so nothing counts it. Name it so its runs land somewhere.` };
  return null;
}

// ── the day's model ────────────────────────────────────────────────────────────────────────────────────────
export type Pin = { a: Automation; at: number; atText: string; tag?: string; state: "done" | "running" | "look" | "later" | "passed"; note: string };
export type Track = { a: Automation; state: "ok" | "look" | "running" | "off"; quietFrom: number | null; note: string };
export type Day = { pins: Pin[]; tracks: Track[]; login: Automation[]; notToday: Automation[]; ranToday: number; looks: { a: Automation; l: Look }[]; next: { a: Automation; at: Date } | null };

export function dayOf(items: Automation[], now = new Date()): Day {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const ranToday = (a: Automation) => (a.today?.length ?? 0) > 0 || (!!a.lastRun && Date.parse(a.lastRun) >= midnight.getTime());
  const looks = items.flatMap((a) => { const l = lookOf(a, now); return l ? [{ a, l }] : []; });
  const isLook = new Set(looks.map((x) => x.a.id));
  const pins: Pin[] = [], tracks: Track[] = [], login: Automation[] = [], notToday: Automation[] = [];
  const pinAt = (a: Automation, at: string, tag?: string) => {
    const [h, m] = at.split(":").map(Number), when = new Date(now); when.setHours(h, m, 0, 0);
    const past = when <= now, rec = a.today?.at(-1);
    const ran = past && ranToday(a) && (!a.lastRun || Date.parse(a.lastRun) >= when.getTime() - 5 * 60e3);
    const state: Pin["state"] = a.status === "running" && past ? "running" : isLook.has(a.id) ? "look" : ran ? "done" : past ? "passed" : "later";
    const took = rec?.secs ? ` · took ${dur(rec.secs)}` : "";
    const note = state === "running" ? `running since ${rec ? hm(new Date(rec.start)) : at}` : state === "done" ? `ran ${hm(new Date(a.lastRun!))}${took}`
      : state === "later" ? `in ${dur((when.getTime() - now.getTime()) / 1000)}` : state === "look" ? looks.find((x) => x.a.id === a.id)!.l.big : "";
    pins.push({ a, at: h + m / 60, atText: at, tag, state, note });
  };
  for (const a of items) {
    const s = a.schedule;
    if (s.kind === "daily") pinAt(a, s.at);
    else if (s.kind === "weekly") { if (s.day === now.getDay()) pinAt(a, s.at, DAYS[s.day]); else notToday.push(a); }
    else if (s.kind === "custom") { const ts = [...s.text.matchAll(/(\d{1,2}):(\d{2})\s*([a-z]+)?/gi)]; if (ts.length) ts.forEach((t) => pinAt(a, `${t[1].padStart(2, "0")}:${t[2]}`, t[3])); else notToday.push(a); }
    else if (s.kind === "login") login.push(a);
    else {
      const look = looks.find((x) => x.a.id === a.id);
      const quietFrom = look && a.lastRun && Date.parse(a.lastRun) >= midnight.getTime() ? hoursOf(new Date(a.lastRun)) : look ? 0 : null;
      tracks.push({ a, quietFrom, state: a.status === "paused" ? "off" : look ? "look" : a.status === "running" ? "running" : "ok",
        note: a.status === "paused" ? "paused" : look ? `quiet since ${a.lastRun ? hm(new Date(a.lastRun)) : "—"}` : s.kind === "always" ? (a.upSec ? `up ${dur(a.upSec)}` : "always on") : a.lastRun ? `last ${hm(new Date(a.lastRun))}` : "not run yet" });
    }
  }
  pins.sort((x, y) => x.at - y.at);
  const next = items.flatMap((a) => (a.nextRun && a.schedule.kind !== "every" && a.status !== "paused" && Date.parse(a.nextRun) > now.getTime() ? [{ a, at: new Date(a.nextRun) }] : []))
    .sort((x, y) => x.at.getTime() - y.at.getTime())[0] ?? null;
  return { pins, tracks, login, notToday, ranToday: items.filter(ranToday).length, looks, next };
}

/** "12 ran today. 3 need a look. Next is the overnight runner at 20:10." */
export function daySentence(d: Day): ReactNode {
  return <>
    {d.ranToday} ran today.{" "}
    {d.looks.length ? <span style={{ color: DC.amber }}>{d.looks.length} need{d.looks.length === 1 ? "s" : ""} a look.</span> : <span style={{ color: DC.green }}>Nothing needs a look.</span>}
    {d.next && <> Next is {d.next.a.name} at {hm(d.next.at)}.</>}
  </>;
}

const PIN_COLOR: Record<Pin["state"], string> = { done: DC.green, running: DC.green, look: DC.amber, later: DC.blue, passed: DC.grey };

// ── desktop: the strip ─────────────────────────────────────────────────────────────────────────────────────
// Slim since V4 of the autopilot-layout pitch (2026-10-22). The T1 strip named every pin in three label lanes, each
// with a line down to its dot: it read as a zig-zag, two dots piled up at 00:15, and a two-time runner was named
// twice. Names now live in the runner table under it (RunnersSection), lined up in columns; the strip only shows
// WHEN — a dot per run, filled once it ran, amber with its time for what needs a look, and the now-line. A dot is
// still a button (it opens that runner) and still says its name on hover.
export function DayStrip({ day, onPick, picked }: { day: Day; onPick: (id: string) => void; picked: string | null }) {
  const now = hoursOf(new Date());
  const pct = (h: number) => `${(h / 24) * 100}%`;
  return (
    <div className="relative" style={{ height: 84 }}>
      <div className="absolute inset-x-0 h-[2px]" style={{ top: 44, background: "rgba(255,255,255,.16)" }} />
      <div className="absolute left-0 h-[3px] rounded-full" style={{ top: 43.5, width: pct(now), background: "rgba(255,255,255,.38)" }} />
      {day.pins.filter((p) => p.state === "look").map((p, i) => (
        <span key={`l${p.a.id}${i}`} className="absolute -translate-x-1/2 whitespace-nowrap text-[13px] font-semibold" style={{ ...MONO, left: pct(p.at), top: 12, color: DC.amber }}>{p.atText}</span>
      ))}
      {day.pins.map((p, i) => {
        const c = PIN_COLOR[p.state], on = picked === p.a.id;
        return (
          <button key={`${p.a.id}-${i}`} type="button" onClick={() => onPick(p.a.id)} title={`${p.a.name} · ${p.atText}${p.note ? ` · ${p.note}` : ""}`} aria-label={`${p.a.name}, ${p.atText}`}
            className="absolute h-[14px] w-[14px] -translate-x-1/2 rounded-full transition-transform hover:scale-125"
            style={{ left: pct(p.at), top: 38, border: `2.5px solid ${c}`, background: p.state === "done" ? c : K.bg, boxShadow: on ? `0 0 0 4px ${tint(c, 35)}` : undefined }} />
        );
      })}
      <div className="pointer-events-none absolute w-[2px]" style={{ left: pct(now), top: 4, height: 56, background: DC.red }} />
      {[0, 6, 12, 18, 24].map((h) => Math.abs(h - now) > 1.4 && (
        <span key={h} className={`absolute text-[12px] ${h === 24 ? "-translate-x-full" : h ? "-translate-x-1/2" : ""}`} style={{ ...MONO, top: 62, left: pct(h), color: K.faint }}>{String(h).padStart(2, "0")}</span>
      ))}
      <span className="absolute -translate-x-1/2 text-[12.5px] font-bold" style={{ ...MONO, left: pct(now), top: 62, color: DC.red }}>{hm(new Date())}</span>
    </div>
  );
}

// ── phone: the day runs down ───────────────────────────────────────────────────────────────────────────────
/** Timed runners top to bottom with the now-line between past and later; repeating ones as one block under it. */
export function PhoneDay({ day, open, onPick, renderOpen }: { day: Day; open: string | null; onPick: (id: string) => void; renderOpen: (a: Automation) => ReactNode }) {
  const now = hoursOf(new Date());
  const past = day.pins.filter((p) => p.at <= now), later = day.pins.filter((p) => p.at > now);
  const Row = ({ p }: { p: Pin }) => (
    <div>
      <button type="button" onClick={() => onPick(p.a.id)} className="grid w-full items-start gap-2.5 py-2 text-left" style={{ gridTemplateColumns: "48px 14px minmax(0,1fr)" }}>
        <span className="pt-0.5 text-[14px]" style={{ ...MONO, color: K.faint }}>{p.atText}</span>
        <span className="mt-[3px] h-[14px] w-[14px] rounded-full" style={{ border: `2.5px solid ${PIN_COLOR[p.state]}`, background: p.state === "done" ? PIN_COLOR[p.state] : "transparent" }} />
        <span className="min-w-0">
          <b className="block truncate text-[16px] font-semibold" style={{ color: p.state === "look" ? DC.amber : undefined }}>{p.a.name}</b>
          <span className="block truncate text-[14px]" style={{ color: K.muted }}>{p.tag ? `${p.tag} · ` : ""}{p.note || p.a.scheduleText}</span>
        </span>
      </button>
      {open === p.a.id && <div className="mb-2">{renderOpen(p.a)}</div>}
    </div>
  );
  return (
    <div className="mx-3.5">
      {past.map((p, i) => <Row key={`${p.a.id}-${i}`} p={p} />)}
      <div className="my-1 flex items-center gap-2 text-[14px] font-bold" style={{ color: DC.red }}>now {hm(new Date())}<i className="h-[2px] flex-1" style={{ background: DC.red }} /></div>
      {later.map((p, i) => <Row key={`${p.a.id}-l${i}`} p={p} />)}
      {day.tracks.length > 0 && (
        <div className="mt-3 rounded-2xl px-3.5 py-2.5" style={{ background: "rgba(255,255,255,.04)", border: `1px solid ${K.line}` }}>
          <p className="text-[11px] font-semibold tracking-[.09em]" style={{ color: K.faint }}>ALL DAY</p>
          {day.tracks.map((t) => (
            <div key={t.a.id}>
              <button type="button" onClick={() => onPick(t.a.id)} className="flex w-full items-center gap-2.5 py-[7px] text-left text-[15px]">
                <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: t.state === "look" ? DC.amber : t.state === "off" ? DC.grey : DC.green }} />
                <span className="min-w-0 flex-1 truncate" style={{ color: t.state === "look" ? DC.amber : undefined }}>{t.a.name}</span>
                <span className="shrink-0 text-[13px]" style={{ color: t.state === "look" ? DC.amber : K.faint }}>{t.note}</span>
              </button>
              {open === t.a.id && <div className="mb-2">{renderOpen(t.a)}</div>}
            </div>
          ))}
        </div>
      )}
      {(day.login.length > 0 || day.notToday.length > 0) && (
        <p className="mt-3 px-1 text-[13.5px] leading-relaxed" style={{ color: K.faint }}>
          {day.login.length > 0 && <>At login: {day.login.map((a) => a.name).join(", ")}. </>}
          {day.notToday.length > 0 && <>Not today: {day.notToday.map((a) => a.name).join(", ")}.</>}
        </p>
      )}
    </div>
  );
}
