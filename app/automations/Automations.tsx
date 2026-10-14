"use client";
// The Automations page (§27): every job that runs on this Mac without being asked, and the controls for it.
// Borrows /today's look (same palette, same fonts) so the two morning-and-evening pages read as one place.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Automation, Schedule } from "@/lib/automations";
import { inter, interVi, mono } from "../today/fonts";

const K = {
  bg: "#0b0e12", paper: "#161b23", ink: "#ffffff", muted: "rgba(255,255,255,.68)", faint: "rgba(255,255,255,.45)",
  line: "rgba(255,255,255,.12)", line2: "rgba(255,255,255,.22)", accent: "#346aff", accentBright: "#90aeff",
  green: "#3ecf8e", amber: "#f3c766", red: "#ff8a8d",
};
const mix = (c: string, p: number) => `color-mix(in srgb, ${c} ${p}%, transparent)`;
const MONO = { fontFamily: "var(--today-mono)" } as const;
const STATUS: Record<Automation["status"], { label: string; color: string }> = {
  running: { label: "RUNNING", color: K.green }, idle: { label: "ON", color: K.accentBright },
  paused: { label: "PAUSED", color: K.amber }, failing: { label: "FAILED LAST RUN", color: K.red }, "not-loaded": { label: "NOT LOADED", color: K.faint },
};
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ago(iso?: string | null) {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000, f = (n: number, u: string) => `${Math.round(n)} ${u} ago`;
  return s < 90 ? "just now" : s < 5400 ? f(s / 60, "min") : s < 129600 ? f(s / 3600, "h") : f(s / 86400, "d");
}
function until(iso?: string | null) {
  if (!iso) return "";
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s < 60) return "any moment";
  const t = new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return s < 5400 ? `in ${Math.round(s / 60)} min` : s < 86400 ? `at ${t}` : `${new Date(iso).toLocaleDateString([], { weekday: "short" })} ${t}`;
}

type Trash = { file: string; id: string; at: string };

export function Automations() {
  const [items, setItems] = useState<Automation[] | null>(null);
  const [bin, setBin] = useState<Trash[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; mode: "edit" | "logs" } | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/automations").then((r) => r.json());
    if (r.error) setErr(r.error); else { setItems(r.items); setBin(r.trash); }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const act = useCallback(async (body: Record<string, unknown>, key: string) => {
    setBusy(key); setErr("");
    try {
      const r = await fetch("/api/automations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
      if (r.error) { setErr(r.error); return false; }
      setItems(r.items); setBin(r.trash); return true;
    } finally { setBusy(null); }
  }, []);

  const groups = useMemo(() => {
    const g = new Map<string, Automation[]>();
    for (const a of items ?? []) { const k = a.project || "Other"; g.set(k, [...(g.get(k) ?? []), a]); }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);
  const counts = useMemo(() => {
    const c = { on: 0, paused: 0, failing: 0 };
    for (const a of items ?? []) a.status === "paused" ? c.paused++ : a.status === "failing" ? c.failing++ : c.on++;
    return c;
  }, [items]);

  return (
    <div className={`${inter.variable} ${interVi.variable} ${mono.variable} min-h-dvh`} style={{ fontFamily: "var(--today-sans), var(--today-sans-vi), ui-sans-serif, system-ui", color: K.ink, background: K.bg }}>
      <div className="mx-auto max-w-[760px] px-5 pb-24 pt-10">
        <div className="mb-1 flex items-center gap-3 text-[12px]" style={{ ...MONO, color: K.faint }}>
          <Link href="/today" style={{ color: K.faint }}>← Today</Link>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[30px] font-semibold tracking-tight">Automations</h1>
            <p className="mt-1 text-[14.5px]" style={{ color: K.muted }}>
              Everything that runs on this Mac without being asked.{" "}
              {items && <span style={{ color: K.faint }}>{counts.on} on · {counts.paused} paused{counts.failing ? <> · <span style={{ color: K.red }}>{counts.failing} failed last run</span></> : null}</span>}
            </p>
          </div>
          <Btn onClick={() => setCreating((v) => !v)} primary>{creating ? "Cancel" : "+ New"}</Btn>
        </div>

        {err && <p className="mt-4 rounded-lg px-3 py-2 text-[13px]" style={{ background: mix(K.red, 14), color: K.red }}>{err}</p>}
        {creating && <Editor onCancel={() => setCreating(false)} busy={busy === "create"}
          onSave={async (v) => { if (await act({ op: "create", ...v }, "create")) setCreating(false); }} />}

        {!items && !err && <p className="pt-24 text-center text-sm" style={{ color: K.muted }}>Loading…</p>}
        {groups.map(([project, list]) => (
          <section key={project} className="mt-9">
            <h2 className="mb-2 text-[11.5px] tracking-[.08em]" style={{ ...MONO, color: K.faint }}>{project.toUpperCase()}</h2>
            <div className="flex flex-col gap-2">
              {list.map((a) => (
                <Row key={a.id} a={a} busy={busy?.endsWith(a.id) ? busy : null} open={open?.id === a.id ? open.mode : null}
                  toggle={(mode) => setOpen(open?.id === a.id && open.mode === mode ? null : { id: a.id, mode })}
                  act={(op, extra) => act({ op, id: a.id, ...extra }, `${op}:${a.id}`)} />
              ))}
            </div>
          </section>
        ))}

        {bin.length > 0 && (
          <details className="mt-10 text-[13px]" style={{ color: K.muted }}>
            <summary className="cursor-pointer" style={{ ...MONO, color: K.faint }}>DELETED · {bin.length}</summary>
            <div className="mt-2 flex flex-col gap-1">
              {bin.map((t) => (
                <div key={t.file} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2" style={{ background: K.paper }}>
                  <span><span style={MONO}>{t.id.replace("com.thomas.", "")}</span> <span style={{ color: K.faint }}>· deleted {ago(t.at)}</span></span>
                  <Btn onClick={() => act({ op: "restore", file: t.file }, `restore:${t.file}`)}>Restore</Btn>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function Row({ a, busy, open, toggle, act }: {
  a: Automation; busy: string | null; open: "edit" | "logs" | null;
  toggle: (m: "edit" | "logs") => void; act: (op: string, extra?: Record<string, unknown>) => Promise<boolean>;
}) {
  const st = STATUS[a.status];
  const paused = a.status === "paused";
  const canRun = a.kind === "launchd" && !paused && a.schedule.kind !== "always";
  const pauseIt = () => {
    if (a.protected && !confirm(`Pause "${a.name}"?\n\n${a.description}`)) return;
    act("pause");
  };
  return (
    <div className="rounded-xl px-4 py-3" style={{ background: K.paper, border: `1px solid ${K.line}`, opacity: paused ? 0.72 : 1 }}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15.5px] font-medium">{a.name}</span>
            <span className="rounded-full px-2 py-0.5 text-[10.5px]" style={{ ...MONO, background: mix(st.color, 18), color: st.color }}>
              {a.status === "running" ? "● " : ""}{st.label}
            </span>
            {a.kind === "inproc" && <span className="text-[10.5px]" style={{ ...MONO, color: K.faint }}>INSIDE MINAMI BOT</span>}
          </div>
          {a.description && <p className="mt-1 text-[13.5px] leading-snug" style={{ color: K.muted }}>{a.description}</p>}
          <div className="mt-1.5 flex flex-wrap gap-x-3 text-[11.5px]" style={{ ...MONO, color: K.faint }}>
            <span style={{ color: K.ink, opacity: 0.8 }}>{a.scheduleText}</span>
            {a.nextRun && <span>next {until(a.nextRun)}</span>}
            {a.lastRun && <span>last {ago(a.lastRun)}</span>}
            {a.status === "failing" && <span style={{ color: K.red }}>exit {a.lastExit}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {canRun && <Btn onClick={() => act("run")} busy={busy === `run:${a.id}`}>▶ Run now</Btn>}
          {a.status === "not-loaded" && a.kind === "launchd" ? <Btn onClick={() => act("resume")} busy={busy === `resume:${a.id}`} primary>Load</Btn>
            : paused ? <Btn onClick={() => act("resume")} busy={busy === `resume:${a.id}`} primary>Resume</Btn>
            : <Btn onClick={pauseIt} busy={busy === `pause:${a.id}`}>❚❚ Pause</Btn>}
          <Btn onClick={() => toggle("edit")} on={open === "edit"}>Edit</Btn>
          {a.kind === "launchd" && <Btn onClick={() => toggle("logs")} on={open === "logs"}>Logs</Btn>}
          {a.kind === "launchd" && !a.protected && <Btn danger busy={busy === `delete:${a.id}`}
            onClick={() => confirm(`Delete "${a.name}"? It stops and moves to Deleted, where you can restore it.`) && act("delete")}>Delete</Btn>}
        </div>
      </div>
      {open === "logs" && <Logs id={a.id} />}
      {open === "edit" && <Editor a={a} busy={busy === `update:${a.id}`} onCancel={() => toggle("edit")}
        onSave={async (v) => { if (await act("update", v)) toggle("edit"); }} />}
    </div>
  );
}

function Logs({ id }: { id: string }) {
  const [text, setText] = useState("Loading…");
  useEffect(() => { fetch(`/api/automations?logs=${encodeURIComponent(id)}`).then((r) => r.json()).then((r) => setText(r.text ?? r.error)); }, [id]);
  return <pre className="mt-3 max-h-[320px] overflow-auto whitespace-pre-wrap rounded-lg p-3 text-[11.5px] leading-relaxed" style={{ ...MONO, background: "rgba(0,0,0,.35)", color: K.muted }}>{text}</pre>;
}

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
  return (
    <div className="mt-3 grid gap-3 rounded-lg p-3 text-[13px]" style={{ background: "rgba(0,0,0,.25)", border: `1px solid ${K.line}` }}>
      {!a && <p className="text-[13px]" style={{ color: K.muted }}>A new launchd job. It runs a shell command on a schedule and logs to ~/.minami/automations/logs.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={d.name} onChange={(v) => set("name", v)} /></Field>
        <Field label="Project"><Input value={d.project} onChange={(v) => set("project", v)} placeholder="Video Studio" /></Field>
      </div>
      <Field label="What it does"><Input value={d.description} onChange={(v) => set("description", v)} /></Field>
      {editable ? (
        <Field label="When">
          <div className="flex flex-wrap items-center gap-2">
            <select value={s.kind} onChange={(e) => setKind(e.target.value as Schedule["kind"])} className="rounded-md px-2 py-1.5" style={inputStyle}>
              <option value="daily">Every day at</option><option value="weekly">Every week on</option><option value="every">Every N minutes</option>
              <option value="login">At login</option><option value="always">Always on</option>
            </select>
            {s.kind === "weekly" && <select value={s.day} onChange={(e) => set("schedule", { ...s, day: Number(e.target.value) })} className="rounded-md px-2 py-1.5" style={inputStyle}>
              {DAYS.map((x, i) => <option key={x} value={i}>{x}</option>)}</select>}
            {(s.kind === "daily" || s.kind === "weekly") && <input type="time" value={s.at} onChange={(e) => set("schedule", { ...s, at: e.target.value })} className="rounded-md px-2 py-1.5" style={inputStyle} />}
            {s.kind === "every" && <><input type="number" min={1} value={s.minutes} onChange={(e) => set("schedule", { ...s, minutes: Number(e.target.value) })} className="w-20 rounded-md px-2 py-1.5" style={inputStyle} /><span style={{ color: K.faint }}>min</span></>}
          </div>
        </Field>
      ) : <p className="text-[12px]" style={{ ...MONO, color: K.faint }}>{a?.kind === "inproc" ? "Its timing lives in its code; this page can pause it and rename it." : `Schedule "${a?.scheduleText}" is more than this page can edit — change the plist.`}</p>}
      {(!a || editable) && (
        <>
          <Field label={a ? "Command — leave empty to keep it" : "Command"}>
            {a && <p className="mb-1 break-all text-[11.5px]" style={{ ...MONO, color: K.faint }}>now: {a.command}</p>}
            <Input mono value={d.command} onChange={(v) => set("command", v)} placeholder="node scripts/topic-plan.mjs nightly" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Folder"><Input mono value={d.workdir} onChange={(v) => set("workdir", v)} /></Field>
            {!a && <Field label="Id (optional)"><Input mono value={d.slug} onChange={(v) => set("slug", v)} placeholder="from the name" /></Field>}
          </div>
        </>
      )}
      <div className="flex gap-2">
        <Btn primary onClick={save} busy={busy}>{a ? "Save" : "Create and start"}</Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}

const inputStyle = { background: "rgba(255,255,255,.06)", border: `1px solid ${K.line2}`, color: K.ink } as const;
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1"><span className="text-[11px] tracking-[.06em]" style={{ ...MONO, color: K.faint }}>{label.toUpperCase()}</span>{children}</label>;
}
function Input({ value, onChange, placeholder, mono: m }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md px-2.5 py-1.5" style={{ ...inputStyle, ...(m ? MONO : {}), fontSize: m ? 12.5 : 13.5 }} />;
}
function Btn({ children, onClick, primary, danger, on, busy }: { children: React.ReactNode; onClick: () => void; primary?: boolean; danger?: boolean; on?: boolean; busy?: boolean }) {
  const c = danger ? K.red : primary ? K.accent : K.ink;
  return (
    <button type="button" onClick={onClick} disabled={busy}
      className="rounded-full px-3 py-1 text-[12px] transition-opacity disabled:opacity-50"
      style={{ ...MONO, background: primary ? K.accent : on ? "rgba(255,255,255,.14)" : mix(c, danger ? 12 : 7), color: primary ? "#fff" : danger ? K.red : K.ink, border: `1px solid ${primary ? K.accent : on ? K.line2 : K.line}` }}>
      {busy ? "…" : children}
    </button>
  );
}
