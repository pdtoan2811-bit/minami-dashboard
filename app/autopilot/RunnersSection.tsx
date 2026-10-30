"use client";
// The Runners section of /autopilot (§27, inside §30): every job that runs on this Mac without being asked, and
// the controls for it.
//
// Since 2026-10-21 it is the Day strip (DayStrip.tsx has the why): one sentence, the runners that need a look as
// cards, then today on a straight line with every runner named on it. The 24-hour lane chart, the filter chips and
// the 16 stacked cards are gone — clicking any pin, track or name opens that runner's card (state, last log line,
// run / pause / edit / log / delete) right under the strip. Nothing that was editable before became unreachable.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Automation, Effect, Heal, Schedule } from "@/lib/automations";
import { K as TK } from "../today/ui";
import { AskBox } from "./AskBox";
import { useAsks } from "./Asks";
import { DayStrip, DC, dayOf, daySentence, type Day } from "./DayStrip";
import { UpNextPanel } from "./UpNext";
import type { UpNext } from "@/lib/upnext";

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

function dur(sec: number) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86400) { const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return m && h < 10 ? `${h} h ${m} min` : `${h} h`; }
  return `${Math.round(sec / 86400)} d`;
}
const EFFECT = { posts: { icon: "📤", label: "Posts publicly" }, spends: { icon: "💸", label: "Spends money" } } as const;
const next = (iso?: string | null) => (iso ? `next ${new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })}` : "not scheduled");
const off_ = (a: Automation) => a.status === "paused" || a.status === "not-loaded";
function EffectBadge({ e }: { e: Effect }) {
  return <span title={e.what} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[.05em]" style={{ ...MONO, background: mix(K.red, 16), color: K.red }}>{EFFECT[e.kind].icon} {EFFECT[e.kind].label}</span>;
}
// Above the list: every runner that publishes or pays, whether it's on, and when it next goes — so it's never a hunt.
function EffectsLine({ items, jump }: { items: Automation[]; jump: (id: string) => void }) {
  const hits = items.flatMap((a) => (a.effects ?? []).map((e) => ({ a, e })));
  if (!hits.length) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {hits.map(({ a, e }) => (
        <button key={a.id + e.kind} onClick={() => jump(a.id)} title={e.what} className="flex items-center gap-2 rounded-xl px-3 py-2 text-left text-[13.5px]" style={{ background: mix(K.red, 8), border: `1px solid ${mix(K.red, 35)}` }}>
          <span className="text-[16px]">{EFFECT[e.kind].icon}</span>
          <span><b style={{ color: K.red }}>{EFFECT[e.kind].label}:</b> {a.name}</span>
          <span style={{ ...MONO, color: K.muted }} className="text-[12px]">{off_(a) ? "· paused" : `· ${next(a.nextRun)}`}</span>
        </button>
      ))}
    </div>
  );
}
// What fixed itself today, and what self-heal won't touch (posting / spending runners) — so the only red left is
// what actually needs Thomas. From bin/minami-heal.mjs and minami-run's retries (2026-10-30).
function HealLine({ heal, jump }: { heal: Heal; jump: (id: string) => void }) {
  const { healedToday: h, needsYou: n } = heal;
  if (!h.length && !n.length) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
      {h.length > 0 && <span title={h.map((x) => `${x.name}: ${x.why}`).join("\n")} className="rounded-xl px-3 py-1.5" style={{ background: mix(K.green, 8), border: `1px solid ${mix(K.green, 30)}` }}>
        <b style={{ color: K.green }}>↻ Fixed itself today: {h.length}</b> <span style={{ color: K.muted }}>· {[...new Set(h.map((x) => x.name))].join(", ")}</span>
      </span>}
      {n.map((x) => (
        <button key={x.id} onClick={() => jump(x.id)} className="rounded-xl px-3 py-1.5 text-left" style={{ background: mix(DC.amber, 8), border: `1px solid ${mix(DC.amber, 35)}` }}>
          <b style={{ color: DC.amber }}>Needs you:</b> {x.name} <span style={{ color: K.muted }}>· {x.why}</span>
        </button>
      ))}
    </div>
  );
}
const ago = (iso?: string | null) => (iso ? (Date.now() - Date.parse(iso) < 60e3 ? "just now" : `${dur((Date.now() - Date.parse(iso)) / 1000)} ago`) : "");
const inT = (iso?: string | null) => (iso ? `in ${dur(Math.max(0, (Date.parse(iso) - Date.now()) / 1000))}` : "");

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
  const [up, setUp] = useState<UpNext | null>(null);
  const [heal, setHeal] = useState<Heal | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/automations").then((r) => r.json()).catch((e) => ({ error: String(e) }));
    if (r.error) setErr(r.error); else { setErr(""); setItems(r.items); setBin(r.trash); setUp(r.upNext ?? null); setHeal(r.heal ?? null); }
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

  return { items, bin, err, busy, act, up, heal, reload: load };
}
export type AutomationsFeed = ReturnType<typeof useAutomations>;

/** `items` arrives already project-filtered. */
// `serving` (the ids working on a visible goal) used to split the list into two bands; the strip is one day, so it
// is accepted and unused until a goal filter on the strip earns it back.
export function RunnersSection({ feed, items }: { feed: AutomationsFeed; items: Automation[] | null; serving: Set<string> }) {
  const { bin, err, busy } = feed;
  const [open, setOpen] = useState<{ id: string; mode: "edit" | "logs" } | null>(null);
  const [creating, setCreating] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [now, tick] = useState(0);

  useEffect(() => {
    // The strip's now-line and "in 4 h" move once a minute; a per-second tick redrew all 16 pins for nothing.
    const clockT = setInterval(() => { if (!document.hidden) tick((n) => n + 1); }, 60_000);
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

  // Every pin, track, name and #auto-<id> link lands here: the runner's card opens under the strip.
  const jump = useCallback((id: string, mode?: "edit" | "logs") => {
    setPicked(id); setOpen(mode ? { id, mode } : null);
    requestAnimationFrame(() => document.getElementById(`auto-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    setFlash(id); setTimeout(() => setFlash(null), 1600);
  }, []);
  // The goal cards' "worked on by" rows are plain #auto-<id> links (no prop drilling across sections); catch the
  // hash here so the runner's card opens under the strip, not just a scroll to somewhere.
  useEffect(() => {
    const onHash = () => { const m = location.hash.match(/^#auto-(.+)$/); if (m) jump(decodeURIComponent(m[1])); };
    onHash(); // arriving at /autopilot#auto-<id> opens it too (it only sets the pick, so the feed can still be loading)
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [jump]);

  const day = useMemo(() => dayOf(items ?? []), [items, now]);
  const openCard = (a: Automation) => (
    <Card a={a} busy={busy} open={open?.id === a.id ? open.mode : null} flash={flash === a.id}
      toggle={(mode) => setOpen(open?.id === a.id && open.mode === mode ? null : { id: a.id, mode })}
      run={(op, extra) => run(a, op, extra)} />
  ); // `now` ticks each minute so the now-line and "in 4 h" move

  return (
    <div>
      <style>{`
        @keyframes auto-pulse { 0% { box-shadow: 0 0 0 0 ${mix(K.green, 60)} } 70% { box-shadow: 0 0 0 7px transparent } 100% { box-shadow: 0 0 0 0 transparent } }
        @keyframes auto-in { from { opacity: 0; transform: translate(-50%, 8px) } to { opacity: 1; transform: translate(-50%, 0) } }
        @keyframes auto-flash { 0%, 100% { box-shadow: 0 0 0 0 transparent } 30% { box-shadow: 0 0 0 2px ${K.accentBright} } }
        @media (prefers-reduced-motion: reduce) { .auto-anim { animation: none !important } }
      `}</style>
      {/* V4 of the autopilot-layout pitch (2026-10-22): the sentence, the slim strip, what needs a look, then every
          other runner in one table with its columns lined up. Chats live in the Minami panel on the right. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        {items && <p className="max-w-[780px] text-[24px] font-semibold leading-snug tracking-tight">{daySentence(day)}</p>}
        <Btn onClick={() => setCreating((v) => !v)} primary>{creating ? "Cancel" : "+ New automation"}</Btn>
      </div>

      {items && <EffectsLine items={items} jump={jump} />}
      {items && feed.heal && <HealLine heal={feed.heal} jump={jump} />}
      {items && feed.up && <UpNextPanel up={feed.up} visible={new Set(items.map((a) => a.id))} jump={jump} reload={feed.reload} now={now} />}
      {err && <p className="mt-4 rounded-lg px-3 py-2 text-[13px]" style={{ background: mix(K.red, 14), color: K.red }}>{err}</p>}
      {creating && <div className="mt-4">
        <Editor onCancel={() => setCreating(false)} busy={busy === "create"}
          onSave={async (v) => { if (await act({ op: "create", ...v }, "create")) { setCreating(false); setToast({ text: `Created “${v.name}” — it's on` }); } }} />
      </div>}

      {!items && !err && <p className="pt-16 text-center text-sm" style={{ color: K.muted }}>Loading…</p>}
      {items && items.length > 0 && <>
        <div className="mt-5 rounded-2xl px-5 pb-2 pt-3" style={{ background: "rgba(255,255,255,.035)", border: `1px solid ${K.line}` }}>
          <DayStrip day={day} picked={picked} onPick={(id) => jump(id)} />
        </div>
        {day.looks.length > 0 && (
          <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
            {/* Its NAME first: "0/10" and "unfiled" as the headline only made sense after reading the name under them. */}
            {day.looks.map(({ a, l }) => (
              <div key={a.id} className="rounded-2xl p-4" style={{ background: mix(DC.amber, 6), border: `1px solid ${mix(DC.amber, 30)}` }}>
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span className="text-[16px] font-semibold">{a.name}</span>
                  <span className="text-[14px] font-semibold" style={{ color: DC.amber }}>{l.big}</span>
                </div>
                <p className="mt-1 text-[14.5px] leading-snug" style={{ color: K.muted }}>{l.why}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <FixIt a={a} why={l.why} />
                  <Btn onClick={() => jump(a.id, "logs")}>Open the log</Btn>
                  {a.kind === "launchd" && a.status !== "running" && a.schedule.kind !== "always" && <Btn onClick={() => run(a, "run")}>Run now</Btn>}
                  {!a.project && <Btn onClick={() => jump(a.id, "edit")}>Name it</Btn>}
                </div>
                {/* "Open the log" / "Name it" open its card here, under the problem it's about. */}
                {picked === a.id && <div className="mt-3">{openCard(a)}</div>}
              </div>
            ))}
          </div>
        )}
        <RunnerTable day={day} picked={picked} pick={(id) => (picked === id ? (setPicked(null), setOpen(null)) : jump(id))}
          renderOpen={openCard} />
      </>}

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
              {a.effects?.map((e) => <EffectBadge key={e.kind} e={e} />)}
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
      {/* About THIS runner: the chat runs in its workdir with its schedule, status and log (lib/autopilot-ask.ts). */}
      {/* Its chat is a thread in the Minami panel (rows={false}): the card stays a card. */}
      <div className="px-4 pb-3 pl-5"><AskBox row rows={false} url="/api/autopilot/ask" body={{ kind: "runner", id: a.id }} field="question" placeholder="Ask Minami about this runner…" /></div>
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
      // Plain type, not mono (V4, 2026-10-22): monospace buttons read as code beside the names.
      className="rounded-full px-3.5 py-1.5 text-[13.5px] font-medium transition-opacity disabled:opacity-50"
      style={{ background: primary ? K.accent : "rgba(255,255,255,.06)", color: "#fff", border: `1px solid ${primary ? K.accent : K.line2}` }}>
      {busy ? "…" : children}
    </button>
  );
}

// "Fix it with Minami" on a runner that needs a look: a chat in the runner's folder with its log tail (lib/autopilot-
// ask.ts), which asks before changing anything. The page stays put; the chat becomes a thread in the Minami panel.
function FixIt({ a, why }: { a: Automation; why: string }) {
  const { asks, reload } = useAsks();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (asks.some((x) => x.kind === "runner" && x.id === a.id && Date.now() - Date.parse(x.at) < 6 * 3600e3)) return null; // already on it
  const go = async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/autopilot/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "runner", id: a.id, question: `Fix it: ${why}` }) }).then((r) => r.json());
      if (r.error) setErr(r.error); else reload();
    } catch { setErr("Couldn't reach the dashboard."); }
    finally { setBusy(false); }
  };
  return <><Btn primary onClick={go} busy={busy}>{busy ? "Starting…" : "Fix it with Minami"}</Btn>{err && <span className="self-center text-[12px]" style={{ color: "#ff8a8d" }}>{err}</span>}</>;
}

// Every runner that doesn't need a look, as one table (V4, 2026-10-22): today's timed runs in order, then the ones
// that repeat or stay on, then at login and other weekdays. The columns line up — name · project · when · how it
// went — so the times compare at a glance; a row opens its card right under it, and the list stays where it was.
function RunnerTable({ day, picked, pick, renderOpen }: { day: Day; picked: string | null; pick: (id: string) => void; renderOpen: (a: Automation) => React.ReactNode }) {
  const look = new Set(day.looks.map((x) => x.a.id));
  const seen = new Set<string>();
  // A runner with two times today (the Slack card: 00:30 lock, 21:30 post) is one row with both times.
  const timed = day.pins.filter((p) => !look.has(p.a.id) && !seen.has(p.a.id) && seen.add(p.a.id)).map((p) => {
    const all = day.pins.filter((x) => x.a.id === p.a.id);
    return { a: p.a, when: all.map((x) => `${x.atText}${x.tag ? ` ${x.tag}` : ""}`).join(" · "), note: all.map((x) => x.note).filter(Boolean).at(-1) ?? "", st: p.state };
  });
  const groups: [string, { a: Automation; when: string; note: string; color: string }[]][] = [
    ["Today, in order", timed.map((r) => ({ ...r, color: r.st === "later" ? DC.blue : r.st === "passed" ? DC.grey : DC.green }))],
    ["All day", day.tracks.filter((t) => !look.has(t.a.id)).map((t) => ({ a: t.a, when: t.a.scheduleText.toLowerCase(), note: t.note, color: t.state === "off" ? DC.grey : DC.green }))],
    ["At login · other days", [...day.login, ...day.notToday].filter((a) => !look.has(a.id)).map((a) => ({ a, when: a.scheduleText, note: a.lastRun ? `last ${ago(a.lastRun)}` : "", color: DC.grey }))],
  ];
  const n = groups.reduce((s, [, r]) => s + r.length, 0);
  if (!n) return null;
  return (
    <div className="mt-7">
      <div className="mb-2.5 text-[12px] font-semibold uppercase tracking-[.07em]" style={{ color: K.faint }}>{day.looks.length ? `The other ${n}` : `All ${n}`}</div>
      <div className="overflow-hidden rounded-2xl" style={{ background: "rgba(0,0,0,.22)", border: `1px solid ${K.line}` }}>
        {groups.filter(([, r]) => r.length).map(([g, rows]) => (
          <div key={g}>
            <div className="px-4 pb-1.5 pt-3.5 text-[12px] font-semibold uppercase tracking-[.07em]" style={{ color: K.faint }}>{g}</div>
            {rows.map((r) => (
              <div key={r.a.id}>
                <button type="button" onClick={() => pick(r.a.id)} className="grid w-full items-center gap-4 px-4 py-2.5 text-left text-[14.5px] hover:bg-white/[0.04]"
                  style={{ gridTemplateColumns: "10px minmax(0,1.4fr) minmax(0,.9fr) 190px minmax(0,1fr)", borderTop: `1px solid ${K.line}`, background: picked === r.a.id ? mix(K.accentBright, 9) : undefined }}>
                  <span className="h-2 w-2 rounded-full" style={{ background: r.color }} />
                  <span className="truncate font-medium">{r.a.name}</span>
                  <span className="truncate text-[13px]" style={{ color: K.faint }}>{r.a.project || "not filed"}</span>
                  <span className="truncate text-[12.5px]" style={{ ...MONO, color: K.muted }}>{r.when}</span>
                  <span className="truncate text-[13.5px]" style={{ color: K.faint }}>{r.note}</span>
                </button>
                {picked === r.a.id && <div className="px-3 pb-3">{renderOpen(r.a)}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
