"use client";
// The Runners section of /autopilot (§27, inside §30): every job that runs on this Mac without being asked, and
// the controls for it. It used to be its own page (/automations); it sits under Goals now, split into the jobs
// that serve a goal and "Housekeeping", because the question it gets opened with is usually "what is working on
// that goal, and is it OK?" — the housekeeping jobs matter, but rarely first.
//
// Read top to bottom it answers, in order: what fires when (the day timeline), what's next (the countdown),
// is anything wrong (the filter chips — red only when something failed), and then each job's own state.
// The state is carried by colour + motion before words: the left stripe and the pill, a pulsing dot while a
// process runs, a dimmed, hatched card when paused, and the last line the job wrote to its log.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Automation, Schedule } from "@/lib/automations";
import { K as TK } from "../today/ui";

const K = { ...TK, green: "#3ecf8e", amber: "#f3c766", red: "#ff8a8d", pink: "#db6393", violet: "#a78bfa" };
const mix = (c: string, p: number) => `color-mix(in srgb, ${c} ${p}%, transparent)`;
const MONO = { fontFamily: "var(--today-mono)" } as const;
const EASE = "cubic-bezier(.22,.61,.21,1)";

type Status = Automation["status"];
export const STATUS: Record<Status, { label: string; color: string; hint: string }> = {
  running: { label: "Running", color: K.green, hint: "a process is up right now" },
  idle: { label: "On", color: K.accentBright, hint: "waiting for its next time" },
  paused: { label: "Paused", color: K.amber, hint: "won't run until you resume it" },
  failing: { label: "Failed", color: K.red, hint: "its last run exited with an error" },
  "not-loaded": { label: "Not loaded", color: K.faint, hint: "launchd isn't holding it — loads at next login" },
};
// One colour per project, the same everywhere on the page (timeline lane, group header, card icon).
const PROJECT_COLOR: Record<string, string> = {
  "Video Studio": K.pink, "Minami Dashboard": K.accentBright, "Second Brain": K.green, Minami: K.violet,
};
const FALLBACK = [K.accent2, K.amber, "#f59e8b", "#7dd3fc"];
const colorOf = (p?: string) => (p && PROJECT_COLOR[p]) || FALLBACK[[...(p || "x")].reduce((a, c) => a + c.charCodeAt(0), 0) % FALLBACK.length];
const KIND_ICON: Record<Schedule["kind"], string> = { daily: "◷", weekly: "▦", every: "↻", login: "⏻", always: "∞", custom: "◷" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// The fixed times a job fires in a day — what the timeline draws. In-process loops carry theirs in the text.
function marks(a: Automation): { at: string; label?: string }[] {
  if (a.schedule.kind === "daily" || a.schedule.kind === "weekly") return [{ at: a.schedule.at, label: a.schedule.kind === "weekly" ? DAYS[a.schedule.day].slice(0, 3) : undefined }];
  if (a.schedule.kind === "custom") return [...a.schedule.text.matchAll(/(\d{1,2}):(\d{2})\s*([a-z]+)?/gi)].map((m) => ({ at: `${m[1].padStart(2, "0")}:${m[2]}`, label: m[3] }));
  return [];
}

function dur(sec: number) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86400) { const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return m && h < 10 ? `${h} h ${m} min` : `${h} h`; }
  return `${Math.round(sec / 86400)} d`;
}
const ago = (iso?: string | null) => (iso ? (Date.now() - Date.parse(iso) < 60e3 ? "just now" : `${dur((Date.now() - Date.parse(iso)) / 1000)} ago`) : "");
const inT = (iso?: string | null) => (iso ? `in ${dur(Math.max(0, (Date.parse(iso) - Date.now()) / 1000))}` : "");
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

type Trash = { file: string; id: string; at: string };
type Toast = { text: string; undo?: () => void; tone?: "bad" };
type Act = (body: Record<string, unknown>, key: string) => Promise<{ items: Automation[]; trash: Trash[] } | { error: string } | null>;

/** The automations feed and its one write path, lifted out of the section so /autopilot can hand the same list
 *  to the goal cards ("worked on by") without a second poll of launchctl. */
export function useAutomations() {
  const [items, setItems] = useState<Automation[] | null>(null);
  const [bin, setBin] = useState<Trash[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/automations").then((r) => r.json()).catch((e) => ({ error: String(e) }));
    if (r.error) setErr(r.error); else { setErr(""); setItems(r.items); setBin(r.trash); }
  }, []);
  useEffect(() => {
    load();
    const poll = setInterval(() => { if (!document.hidden) load(); }, 15_000);
    return () => clearInterval(poll);
  }, [load]);

  // Returns { error } rather than toasting here: the toast belongs to the section that shows it.
  const act: Act = useCallback(async (body, key) => {
    setBusy(key);
    try {
      const r = await fetch("/api/automations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
      if (r.error) return { error: String(r.error) };
      setItems(r.items); setBin(r.trash); return r as { items: Automation[]; trash: Trash[] };
    } finally { setBusy(null); }
  }, []);

  return { items, bin, err, busy, act };
}
export type AutomationsFeed = ReturnType<typeof useAutomations>;

/** `items` arrives already project-filtered; `serving` is the set of ids that work on a visible goal. */
export function RunnersSection({ feed, items, serving }: { feed: AutomationsFeed; items: Automation[] | null; serving: Set<string> }) {
  const { bin, err, busy } = feed;
  const [open, setOpen] = useState<{ id: string; mode: "edit" | "logs" } | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<Status | "all">("all");
  const [flash, setFlash] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const clockT = setInterval(() => { if (!document.hidden) tick((n) => n + 1); }, 1_000); // countdowns stay true
    return () => clearInterval(clockT);
  }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 7000); return () => clearTimeout(t); }, [toast]);

  const act = useCallback(async (body: Record<string, unknown>, key: string) => {
    const r = await feed.act(body, key);
    if (r && "error" in r) { setToast({ text: r.error, tone: "bad" }); return null; }
    return r;
  }, [feed]);

  // Every action that changes state says what it did, and the reversible ones offer Undo.
  const run = useCallback(async (a: Automation, op: string, extra?: Record<string, unknown>) => {
    const r = await act({ op, id: a.id, ...extra }, `${op}:${a.id}`);
    if (!r) return false;
    if (op === "pause") setToast({ text: `Paused “${a.name}”`, undo: () => act({ op: "resume", id: a.id }, `resume:${a.id}`) });
    else if (op === "resume") setToast({ text: `“${a.name}” is on again` });
    else if (op === "run") setToast({ text: `Started “${a.name}”` });
    else if (op === "delete") {
      const t = r.trash.find((x) => x.id === a.id);
      setToast({ text: `Deleted “${a.name}”`, undo: t ? () => act({ op: "restore", file: t.file }, `restore:${t.file}`) : undefined });
    } else if (op === "update") setToast({ text: `Saved “${a.name}”` });
    return true;
  }, [act]);

  const jump = useCallback((id: string) => {
    setFilter("all");
    requestAnimationFrame(() => document.getElementById(`auto-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    setFlash(id); setTimeout(() => setFlash(null), 1600);
  }, []);
  // The goal cards' "worked on by" rows are plain #auto-<id> links (no prop drilling across sections); catch the
  // hash here so the card is un-filtered and flashed, not just scrolled to — or not found, if a chip hid it.
  useEffect(() => {
    const onHash = () => { const m = location.hash.match(/^#auto-(.+)$/); if (m) jump(decodeURIComponent(m[1])); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [jump]);

  const counts = useMemo(() => {
    const c: Record<Status, number> = { running: 0, idle: 0, paused: 0, failing: 0, "not-loaded": 0 };
    for (const a of items ?? []) c[a.status]++;
    return c;
  }, [items]);
  // Two bands, each grouped by project: the jobs that serve a goal first, then everything else.
  const bands = useMemo(() => {
    const group = (list: Automation[]) => {
      const g = new Map<string, Automation[]>();
      for (const a of list) { const k = a.project || "Other"; g.set(k, [...(g.get(k) ?? []), a]); }
      return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    };
    const shown = (items ?? []).filter((a) => filter === "all" || a.status === filter);
    return [
      { key: "serving", label: "Serving a goal", groups: group(shown.filter((a) => serving.has(a.id))) },
      { key: "housekeeping", label: "Housekeeping", groups: group(shown.filter((a) => !serving.has(a.id))) },
    ].filter((b) => b.groups.length);
  }, [items, filter, serving]);

  return (
    <div>
      <style>{`
        @keyframes auto-pulse { 0% { box-shadow: 0 0 0 0 ${mix(K.green, 60)} } 70% { box-shadow: 0 0 0 7px transparent } 100% { box-shadow: 0 0 0 0 transparent } }
        @keyframes auto-in { from { opacity: 0; transform: translate(-50%, 8px) } to { opacity: 1; transform: translate(-50%, 0) } }
        @keyframes auto-flash { 0%, 100% { box-shadow: 0 0 0 0 transparent } 30% { box-shadow: 0 0 0 2px ${K.accentBright} } }
        @media (prefers-reduced-motion: reduce) { .auto-anim { animation: none !important } }
      `}</style>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight">Runners</h2>
          <p className="mt-1 text-[14px]" style={{ color: K.muted }}>Everything that runs on this Mac without being asked.</p>
        </div>
        <Btn onClick={() => setCreating((v) => !v)} primary>{creating ? "Cancel" : "+ New automation"}</Btn>
      </div>

      {err && <p className="mt-4 rounded-lg px-3 py-2 text-[13px]" style={{ background: mix(K.red, 14), color: K.red }}>{err}</p>}
      {creating && <div className="mt-4">
        <Editor onCancel={() => setCreating(false)} busy={busy === "create"}
          onSave={async (v) => { if (await act({ op: "create", ...v }, "create")) { setCreating(false); setToast({ text: `Created “${v.name}” — it's on` }); } }} />
      </div>}

      {!items && !err && <p className="pt-16 text-center text-sm" style={{ color: K.muted }}>Loading…</p>}
      {items && items.length > 0 && <>
        <NextUp items={items} onJump={jump} />
        <Timeline items={items} onJump={jump} />
        <div className="mt-6 flex flex-wrap gap-2">
          <Chip on={filter === "all"} onClick={() => setFilter("all")} color={K.ink} n={items.length}>All</Chip>
          {(["running", "idle", "paused", "failing", "not-loaded"] as Status[]).map((s) => (counts[s] || s === "failing") ? (
            <Chip key={s} on={filter === s} onClick={() => setFilter(filter === s ? "all" : s)} color={STATUS[s].color} n={counts[s]} quiet={!counts[s]}>
              {s === "failing" && !counts[s] ? "Nothing failed" : STATUS[s].label}
            </Chip>
          ) : null)}
        </div>
      </>}

      {bands.map((band) => (
        <div key={band.key} className="mt-8">
          <h3 className="text-[15px] font-semibold tracking-tight">{band.label}
            <span className="ml-2 text-[11.5px] font-normal" style={{ ...MONO, color: K.faint }}>{band.groups.reduce((n, [, l]) => n + l.length, 0)}</span>
          </h3>
          {band.groups.map(([project, list]) => (
            <section key={project} className="mt-4">
              <h4 className="mb-2.5 flex items-center gap-2 text-[11.5px] tracking-[.08em]" style={{ ...MONO, color: K.faint }}>
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: colorOf(project) }} />{project.toUpperCase()}
                <span style={{ opacity: 0.6 }}>· {list.length}</span>
              </h4>
              <div className="flex flex-col gap-2.5">
                {list.map((a) => (
                  <Card key={a.id} a={a} busy={busy} open={open?.id === a.id ? open.mode : null} flash={flash === a.id}
                    toggle={(mode) => setOpen(open?.id === a.id && open.mode === mode ? null : { id: a.id, mode })}
                    run={(op, extra) => run(a, op, extra)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      ))}
      {items && items.length > 0 && !bands.length && <p className="mt-10 text-center text-[14px]" style={{ color: K.muted }}>Nothing is {STATUS[filter as Status]?.label.toLowerCase()}.</p>}

      {bin.length > 0 && (
        <details className="mt-12 text-[13px]" style={{ color: K.muted }}>
          <summary className="cursor-pointer" style={{ ...MONO, color: K.faint }}>DELETED · {bin.length} — restorable</summary>
          <div className="mt-2 flex flex-col gap-1">
            {bin.map((t) => (
              <div key={t.file} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2" style={{ background: K.paper }}>
                <span><span style={MONO}>{t.id.replace("com.thomas.", "")}</span> <span style={{ color: K.faint }}>· deleted {ago(t.at)}</span></span>
                <Btn onClick={async () => { if (await act({ op: "restore", file: t.file }, `restore:${t.file}`)) setToast({ text: "Restored — it's on again" }); }}>Restore</Btn>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* bottom-24 on phones: the shell's fixed bottom bar (§30) would otherwise sit on top of the Undo. */}
      {toast && (
        <div className="auto-anim fixed bottom-24 left-1/2 z-50 flex max-w-[calc(100vw-24px)] items-center gap-4 rounded-full px-5 py-2.5 text-[13.5px] shadow-2xl sm:bottom-6"
          style={{ transform: "translateX(-50%)", animation: `auto-in .25s ${EASE}`, background: toast.tone === "bad" ? "#3a1d22" : "#232b38", border: `1px solid ${toast.tone === "bad" ? mix(K.red, 50) : K.line2}`, color: toast.tone === "bad" ? K.red : K.ink }}>
          <span>{toast.text}</span>
          {toast.undo && <button type="button" onClick={() => { toast.undo!(); setToast(null); }} className="font-medium" style={{ color: K.accentBright }}>Undo</button>}
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss" style={{ color: K.faint }}>✕</button>
        </div>
      )}
    </div>
  );
}

// ── what's next ─────────────────────────────────────────────────────────────────────────────────────────────
function NextUp({ items, onJump }: { items: Automation[]; onJump: (id: string) => void }) {
  const now = Date.now();
  const next = items.filter((a) => a.nextRun && a.schedule.kind !== "every" && Date.parse(a.nextRun) > now)
    .sort((a, b) => Date.parse(a.nextRun!) - Date.parse(b.nextRun!))[0];
  const running = items.filter((a) => a.status === "running" && a.schedule.kind !== "always");
  if (!next && !running.length) return null;
  return (
    <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl px-4 py-3" style={{ background: `linear-gradient(90deg, ${mix(colorOf(next?.project), 14)}, ${K.paper} 70%)`, border: `1px solid ${K.line}` }}>
      {running.map((a) => (
        <button key={a.id} type="button" onClick={() => onJump(a.id)} className="flex items-center gap-2 text-left text-[14px]">
          <Dot color={K.green} pulse /> <span><b className="font-medium">{a.name}</b> <span style={{ color: K.muted }}>is running{a.upSec ? ` · ${dur(a.upSec)}` : ""}</span></span>
        </button>
      ))}
      {next && (
        <button type="button" onClick={() => onJump(next.id)} className="flex flex-wrap items-baseline gap-x-3 text-left">
          <span className="text-[11px] tracking-[.08em]" style={{ ...MONO, color: K.faint }}>NEXT</span>
          <span className="text-[15px] font-medium">{next.name}</span>
          <span className="tabular-nums text-[14px]" style={{ ...MONO, color: colorOf(next.project) }}>{inT(next.nextRun)}</span>
          <span className="text-[12px]" style={{ ...MONO, color: K.faint }}>at {clock(next.nextRun!)}</span>
        </button>
      )}
    </div>
  );
}

// ── the day, as lanes ───────────────────────────────────────────────────────────────────────────────────────
// 06:00 → 06:00, so the night's chain (plan 20:00 → card 21:30 → lock 00:30) sits in the middle instead of
// being cut at midnight. One lane per project; fixed times are dots joined by a line, repeating jobs a
// dotted band, always-on jobs a solid one.
const START = 6;
const pos = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (((h - START + 24) % 24) + m / 60) / 24 * 100; };

function Timeline({ items, onJump }: { items: Automation[]; onJump: (id: string) => void }) {
  const lanes = useMemo(() => {
    const g = new Map<string, Automation[]>();
    for (const a of items) { const k = a.project || "Other"; g.set(k, [...(g.get(k) ?? []), a]); }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);
  const d = new Date();
  const nowPct = pos(`${d.getHours()}:${d.getMinutes()}`);
  const hours = [6, 9, 12, 15, 18, 21, 0, 3];
  return (
    <div className="mt-3 overflow-x-auto rounded-xl" style={{ background: K.paper, border: `1px solid ${K.line}` }}>
      <div className="relative min-w-[660px] px-4 pb-2 pt-3">
        <div className="mb-2 flex flex-col gap-1 text-[11px] tracking-[.08em] sm:flex-row sm:items-center sm:justify-between sm:gap-0" style={{ ...MONO, color: K.faint }}>
          <span>YOUR 24 HOURS</span><span className="tracking-normal">● fixed time · ┈ repeats · ━ always on · ○ paused</span>
        </div>
        <div className="relative ml-[96px] sm:ml-[140px]">
          <div className="absolute inset-y-0" style={{ left: `${pos("22:00")}%`, right: 0, background: "linear-gradient(90deg, transparent, rgba(110,130,255,.08) 10%)", borderRadius: 6 }} />
          {hours.map((h) => (
            <div key={h} className="absolute inset-y-0" style={{ left: `${pos(`${h}:00`)}%`, borderLeft: `1px dashed ${K.line}` }}>
              <span className="absolute left-1 top-0 text-[10px]" style={{ ...MONO, color: K.faint }}>{String(h).padStart(2, "0")}:00</span>
            </div>
          ))}
          <div className="relative pt-5">
            {lanes.map(([project, list]) => <Lane key={project} project={project} list={list} onJump={onJump} />)}
          </div>
          <div className="pointer-events-none absolute bottom-0 top-4" style={{ left: `${nowPct}%`, borderLeft: `1.5px solid ${K.accent2}` }}>
            <span className="absolute -top-1 -translate-x-1/2 rounded px-1 text-[10px] font-semibold" style={{ ...MONO, background: K.accent2, color: K.bg }}>now</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Lane({ project, list, onJump }: { project: string; list: Automation[]; onJump: (id: string) => void }) {
  const c = colorOf(project);
  // Two times close together (07:30 / 09:00) would print over each other: step the second label down a line.
  const pts = list.flatMap((a) => marks(a).map((m) => ({ a, ...m, x: pos(m.at), row: 0 }))).sort((p, q) => p.x - q.x);
  pts.forEach((p, i) => { if (i && p.x - pts[i - 1].x < 9 && pts[i - 1].row === 0) p.row = 1; });
  const rows = pts.some((p) => p.row) ? 2 : 1;
  const bands = list.filter((a) => a.schedule.kind === "every" || a.schedule.kind === "always");
  const top = pts.length ? 24 + rows * 12 : 8; // where the bands start, under the labels
  const h = Math.max(44, top + bands.length * 7 + 6);
  return (
    <div className="relative" style={{ height: h, borderTop: `1px solid ${mix(K.line, 50)}` }}>
      <span className="absolute -left-[96px] top-[12px] w-[88px] truncate sm:-left-[140px] sm:w-[132px] text-[12px]" style={{ color: K.muted }} title={project}>
        <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: c }} />{project}
      </span>
      {bands.map((a, i) => {
        const off = a.status === "paused" || a.status === "not-loaded";
        const gap = a.schedule.kind === "every" ? Math.max(5, a.schedule.minutes / 1440 * 640) : 0;
        return (
          <button key={a.id} type="button" onClick={() => onJump(a.id)} title={`${a.name} · ${a.scheduleText}${off ? " · paused" : ""}`}
            className="absolute left-0 right-0 rounded-full" style={{ top: top + i * 7, height: 3, opacity: off ? 0.2 : 0.75,
              background: a.schedule.kind === "always" ? c : `repeating-linear-gradient(90deg, ${c} 0 2px, transparent 2px ${gap}px)` }} />
        );
      })}
      {pts.length > 1 && <div className="absolute h-[2px] rounded-full" style={{ top: 17, left: `${pts[0].x}%`, width: `${pts[pts.length - 1].x - pts[0].x}%`, background: `linear-gradient(90deg, ${mix(c, 20)}, ${mix(c, 55)})` }} />}
      {pts.map((p, i) => {
        const off = p.a.status === "paused" || p.a.status === "not-loaded";
        const bad = p.a.status === "failing";
        const col = bad ? K.red : c;
        return (
          <button key={`${p.a.id}-${i}`} type="button" onClick={() => onJump(p.a.id)} title={`${p.at} · ${p.a.name}${p.label ? ` (${p.label})` : ""}${off ? " · paused" : ""}`}
            className="group absolute -translate-x-1/2" style={{ left: `${p.x}%`, top: 11 }}>
            <span className="block h-[14px] w-[14px] rounded-full transition-transform group-hover:scale-125"
              style={{ background: off ? K.bg : col, border: `2px ${off ? "dashed" : "solid"} ${col}`, boxShadow: off ? "none" : `0 0 12px ${mix(col, 60)}` }} />
            {p.row > 0 && <span className="absolute left-1/2 top-[14px] h-[10px] w-px -translate-x-1/2" style={{ background: mix(col, 40) }} />}
            <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] tabular-nums" style={{ ...MONO, top: 16 + p.row * 12, color: off ? K.faint : K.muted }}>
              {p.at}{p.label ? ` ${p.label}` : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── one job ─────────────────────────────────────────────────────────────────────────────────────────────────
function Card({ a, busy, open, flash, toggle, run }: {
  a: Automation; busy: string | null; open: "edit" | "logs" | null; flash: boolean;
  toggle: (m: "edit" | "logs") => void; run: (op: string, extra?: Record<string, unknown>) => Promise<boolean>;
}) {
  const st = STATUS[a.status];
  const paused = a.status === "paused";
  const off = paused || a.status === "not-loaded";
  const canRun = a.kind === "launchd" && !off && a.schedule.kind !== "always" && a.status !== "running";
  const isBusy = (op: string) => busy === `${op}:${a.id}`;
  const flip = () => {
    if (off) return run("resume");
    if (a.protected && !confirm(`Pause “${a.name}”?\n\n${a.description}`)) return;
    run("pause");
  };
  return (
    <div id={`auto-${a.id}`} className="auto-anim relative rounded-xl" style={{
      background: paused ? `repeating-linear-gradient(135deg, ${K.paper} 0 10px, #13171e 10px 20px)` : K.paper,
      border: `1px solid ${a.status === "failing" ? mix(K.red, 45) : K.line}`, animation: flash ? `auto-flash 1.6s ${EASE}` : undefined,
    }}>
      <div className="absolute inset-y-0 left-0 w-[3px] rounded-l-xl" style={{ background: st.color, opacity: off ? 0.6 : 1 }} />
      <div className="px-4 py-3.5 pl-5">
        <div className="flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap">
          <div className="min-w-0 flex-1 basis-full sm:basis-0" style={{ opacity: off ? 0.62 : 1, transition: `opacity .3s ${EASE}` }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px]" style={{ color: colorOf(a.project) }} title={a.scheduleText}>{KIND_ICON[a.schedule.kind]}</span>
              <span className="text-[15.5px] font-medium">{a.name}</span>
              <span title={st.hint} className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-[.05em]" style={{ ...MONO, background: mix(st.color, 16), color: st.color }}>
                {a.status === "running" && <Dot color={K.green} pulse small />}{st.label}
              </span>
              {a.kind === "inproc" && <span className="text-[10.5px]" style={{ ...MONO, color: K.faint }} title="A loop inside the Minami bot — if the bot is off, so is this">⊂ inside Minami bot</span>}
              {a.protected && <span className="text-[11px]" style={{ color: K.faint }} title="Can be paused, not deleted">🔒</span>}
            </div>
            {a.description && <p className="mt-1 text-[13.5px] leading-snug" style={{ color: K.muted }}>{a.description}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {canRun && <IconBtn title="Run now" onClick={() => run("run")} busy={isBusy("run")}>▶</IconBtn>}
            <Switch on={!off} onClick={flip} busy={isBusy("pause") || isBusy("resume")} label={off ? (a.status === "not-loaded" ? "Load it" : "Resume") : "Pause"} />
            <Menu items={[
              { label: open === "edit" ? "Close editor" : "✎  Edit", onClick: () => toggle("edit") },
              ...(a.kind === "launchd" ? [{ label: open === "logs" ? "Hide log" : "≡  Full log", onClick: () => toggle("logs") }] : []),
              ...(a.kind === "launchd" && !a.protected ? [{ label: "✕  Delete…", danger: true, onClick: () => { if (confirm(`Delete “${a.name}”? It stops and moves to Deleted, where you can restore it.`)) run("delete"); } }] : []),
            ]} />
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" style={{ ...MONO, opacity: off ? 0.8 : 1 }}>
          <span style={{ color: K.ink, opacity: 0.85 }}>{a.scheduleText}</span>
          {a.status === "running" && a.upSec != null && <Meta icon="●" color={K.green}>up {dur(a.upSec)}</Meta>}
          {paused && <Meta icon="❚❚" color={K.amber}>paused{a.pausedAt ? ` ${ago(a.pausedAt)}` : ""}</Meta>}
          {a.status === "not-loaded" && <Meta icon="○">loads at next login</Meta>}
          {!off && a.nextRun && a.schedule.kind !== "always" && <Meta icon="→" color={K.muted}>next {inT(a.nextRun)}</Meta>}
          {a.lastRun && <Meta icon={a.status === "failing" ? "✕" : "✓"} color={a.status === "failing" ? K.red : undefined}>{a.status === "failing" ? `failed ${ago(a.lastRun)} · exit ${a.lastExit}` : `last ${ago(a.lastRun)}`}</Meta>}
        </div>
        {a.lastLine && (
          <button type="button" onClick={() => a.kind === "launchd" && toggle("logs")} title="The last thing it wrote to its log — click for the full log"
            className="mt-2 block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[11.5px]"
            style={{ ...MONO, background: a.status === "failing" ? mix(K.red, 10) : "rgba(0,0,0,.28)", color: a.status === "failing" ? K.red : K.faint }}>
            › {a.lastLine}
          </button>
        )}
      </div>
      {open === "logs" && <div className="px-4 pb-3 pl-5"><Logs id={a.id} /></div>}
      {open === "edit" && <div className="px-3 pb-3"><Editor a={a} busy={isBusy("update")} onCancel={() => toggle("edit")}
        onSave={async (v) => { if (await run("update", v)) toggle("edit"); }} /></div>}
    </div>
  );
}

function Logs({ id }: { id: string }) {
  const [text, setText] = useState("Loading…");
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { fetch(`/api/automations?logs=${encodeURIComponent(id)}`).then((r) => r.json()).then((r) => setText(r.text ?? r.error)); }, [id]);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [text]);
  return <pre ref={ref} className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-lg p-3 text-[11.5px] leading-relaxed" style={{ ...MONO, background: "rgba(0,0,0,.4)", color: K.muted }}>{text}</pre>;
}

// ── create / edit ───────────────────────────────────────────────────────────────────────────────────────────
type Draft = { slug: string; name: string; description: string; project: string; command: string; workdir: string; schedule: Schedule };

function Editor({ a, onSave, onCancel, busy }: { a?: Automation; onSave: (v: Partial<Draft>) => void; onCancel: () => void; busy: boolean }) {
  const editable = !a || (a.kind === "launchd" && a.schedule.kind !== "custom");
  const [d, setD] = useState<Draft>({
    slug: "", name: a?.name ?? "", description: a?.description ?? "", project: a?.project ?? "",
    command: "", workdir: a?.workdir ?? "~", schedule: a?.schedule.kind === "custom" || !a ? { kind: "daily", at: "09:00" } : a.schedule,
  });
  const set = (k: keyof Draft, v: unknown) => setD((x) => ({ ...x, [k]: v }));
  const s = d.schedule;
  const setKind = (kind: Schedule["kind"]) => set("schedule", kind === "daily" ? { kind, at: "at" in s ? s.at : "09:00" } : kind === "weekly" ? { kind, day: 1, at: "at" in s ? s.at : "09:00" } : kind === "every" ? { kind, minutes: 30 } : { kind });
  const save = () => {
    const v: Partial<Draft> = { name: d.name, description: d.description, project: d.project };
    if (editable) { v.schedule = d.schedule; v.workdir = d.workdir; }
    if (!a) Object.assign(v, { slug: d.slug || d.name, command: d.command });
    else if (d.command.trim()) v.command = d.command;
    onSave(v);
  };
  const KINDS: { k: Schedule["kind"]; label: string }[] = [
    { k: "daily", label: "◷ Daily" }, { k: "weekly", label: "▦ Weekly" }, { k: "every", label: "↻ Every N min" }, { k: "login", label: "⏻ At login" }, { k: "always", label: "∞ Always on" },
  ];
  return (
    <div className="grid gap-3.5 rounded-lg p-3.5 text-[13px]" style={{ background: a ? "rgba(0,0,0,.28)" : K.paper, border: `1px solid ${a ? K.line : K.line2}` }}>
      {!a && <p className="text-[13px]" style={{ color: K.muted }}>A new job: a shell command on a schedule. It logs to <span style={MONO}>~/.minami/automations/logs</span> and shows up here.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={d.name} onChange={(v) => set("name", v)} placeholder="Weekly StoreLeads digest" /></Field>
        <Field label="Project"><Input value={d.project} onChange={(v) => set("project", v)} placeholder="Video Studio" /></Field>
      </div>
      <Field label="What it does"><Input value={d.description} onChange={(v) => set("description", v)} placeholder="One line, so future-you knows why it runs" /></Field>
      {editable ? (
        <div className="grid gap-1">
          <span className="text-[11px] tracking-[.06em]" style={{ ...MONO, color: K.faint }}>WHEN</span>
          <div className="flex flex-wrap gap-1.5">
            {KINDS.map(({ k, label }) => (
              <button key={k} type="button" onClick={() => setKind(k)} className="rounded-full px-3 py-1 text-[12px]"
                style={{ ...MONO, background: s.kind === k ? mix(K.accent, 30) : "rgba(255,255,255,.05)", border: `1px solid ${s.kind === k ? K.accent : K.line}`, color: s.kind === k ? K.ink : K.muted }}>{label}</button>
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {s.kind === "weekly" && <select value={s.day} onChange={(e) => set("schedule", { ...s, day: Number(e.target.value) })} className="rounded-md px-2 py-1.5" style={inputStyle}>
              {DAYS.map((x, i) => <option key={x} value={i}>{x}</option>)}</select>}
            {(s.kind === "daily" || s.kind === "weekly") && <><span style={{ color: K.faint }}>at</span><input type="time" value={s.at} onChange={(e) => set("schedule", { ...s, at: e.target.value })} className="rounded-md px-2 py-1.5" style={inputStyle} /></>}
            {s.kind === "every" && <><span style={{ color: K.faint }}>every</span><input type="number" min={1} value={s.minutes} onChange={(e) => set("schedule", { ...s, minutes: Number(e.target.value) })} className="w-20 rounded-md px-2 py-1.5" style={inputStyle} /><span style={{ color: K.faint }}>minutes</span></>}
            {s.kind === "login" && <span style={{ color: K.faint }}>Runs once each time you log in.</span>}
            {s.kind === "always" && <span style={{ color: K.faint }}>Kept running; restarted if it stops.</span>}
          </div>
        </div>
      ) : <p className="text-[12px]" style={{ ...MONO, color: K.faint }}>{a?.kind === "inproc" ? "Its timing lives in its code — here you can pause it and rename it." : `“${a?.scheduleText}” is more than this page can edit — change the plist.`}</p>}
      {(!a || editable) && (
        <>
          <Field label={a ? "Command — leave empty to keep it" : "Command"}>
            {a && <p className="mb-1 break-all text-[11.5px]" style={{ ...MONO, color: K.faint }}>now: {a.command}</p>}
            <Input mono value={d.command} onChange={(v) => set("command", v)} placeholder="node scripts/topic-plan.mjs nightly" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Run in folder"><Input mono value={d.workdir} onChange={(v) => set("workdir", v)} /></Field>
            {!a && <Field label="Id (optional)"><Input mono value={d.slug} onChange={(v) => set("slug", v)} placeholder="from the name" /></Field>}
          </div>
        </>
      )}
      <div className="flex gap-2">
        <Btn primary onClick={save} busy={busy}>{a ? "Save changes" : "Create and turn on"}</Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}

// ── small parts ─────────────────────────────────────────────────────────────────────────────────────────────
const inputStyle = { background: "rgba(255,255,255,.06)", border: `1px solid ${K.line2}`, color: K.ink } as const;
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1"><span className="text-[11px] tracking-[.06em]" style={{ ...MONO, color: K.faint }}>{label.toUpperCase()}</span>{children}</label>;
}
function Input({ value, onChange, placeholder, mono: m }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md px-2.5 py-1.5" style={{ ...inputStyle, ...(m ? MONO : {}), fontSize: m ? 12.5 : 13.5 }} />;
}
function Dot({ color, pulse, small }: { color: string; pulse?: boolean; small?: boolean }) {
  const s = small ? 6 : 8;
  return <span className="auto-anim inline-block shrink-0 rounded-full" style={{ width: s, height: s, background: color, animation: pulse ? "auto-pulse 1.8s infinite" : undefined }} />;
}
function Meta({ icon, color, children }: { icon: string; color?: string; children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 tabular-nums" style={{ color: color ?? K.faint }}><span style={{ fontSize: 10 }}>{icon}</span>{children}</span>;
}
function Chip({ children, on, onClick, color, n, quiet }: { children: React.ReactNode; on: boolean; onClick: () => void; color: string; n: number; quiet?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={quiet} className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12.5px] transition-colors"
      style={{ background: on ? mix(color, 20) : "rgba(255,255,255,.04)", border: `1px solid ${on ? mix(color, 60) : K.line}`, color: quiet ? K.faint : on ? K.ink : K.muted, cursor: quiet ? "default" : "pointer" }}>
      {quiet ? <span style={{ color: K.green }}>✓</span> : <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
      {children}{!quiet && <span className="tabular-nums" style={{ ...MONO, color: K.faint }}>{n}</span>}
    </button>
  );
}
function Switch({ on, onClick, busy, label }: { on: boolean; onClick: () => void; busy?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} disabled={busy} title={label}
      className="relative h-[24px] w-[42px] shrink-0 rounded-full disabled:opacity-60"
      style={{ background: on ? K.green : "rgba(255,255,255,.16)", transition: `background .25s ${EASE}` }}>
      <span className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow" style={{ left: on ? 21 : 3, transition: `left .25s ${EASE}` }} />
    </button>
  );
}
function IconBtn({ children, onClick, title, busy }: { children: React.ReactNode; onClick: () => void; title: string; busy?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title} disabled={busy}
      className="grid h-[28px] w-[28px] place-items-center rounded-full text-[11px] transition-colors hover:bg-white/10 disabled:opacity-50"
      style={{ border: `1px solid ${K.line2}`, color: K.ink }}>{busy ? "…" : children}</button>
  );
}
function Menu({ items }: { items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <IconBtn title="More" onClick={() => setOpen((v) => !v)}>⋯</IconBtn>
      {open && (
        <div className="absolute right-0 top-[32px] z-20 min-w-[160px] overflow-hidden rounded-lg py-1 shadow-2xl" style={{ background: "#232b38", border: `1px solid ${K.line2}` }}>
          {items.map((it) => (
            <button key={it.label} type="button" onClick={() => { setOpen(false); it.onClick(); }}
              className="block w-full px-3.5 py-2 text-left text-[13px] hover:bg-white/10" style={{ color: it.danger ? K.red : K.ink }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
function Btn({ children, onClick, primary, busy }: { children: React.ReactNode; onClick: () => void; primary?: boolean; busy?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={busy}
      className="rounded-full px-3.5 py-1.5 text-[12.5px] transition-opacity disabled:opacity-50"
      style={{ ...MONO, background: primary ? K.accent : "rgba(255,255,255,.06)", color: "#fff", border: `1px solid ${primary ? K.accent : K.line}` }}>
      {busy ? "…" : children}
    </button>
  );
}
