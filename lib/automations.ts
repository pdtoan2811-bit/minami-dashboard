// Automations (§27): one place to see and control everything that runs on this Mac without being asked.
// Thomas, 2026-10-14: "need a place to handle, list all autonomous things like these and CRUD, pause etc".
//
// Two kinds, one list:
//   launchd  — every ~/Library/LaunchAgents/com.thomas.*.plist. launchd IS the scheduler, so it is also the
//              source of truth: the schedule, the command and the log path are read from the plist on every
//              request, and pause is `launchctl disable` + `bootout` (survives a reboot, unlike bootout alone).
//   inproc   — loops that live inside a long-running process (the Minami bot's video-plan clock). They can't
//              be unloaded, so pausing one writes ~/.minami/automations/paused/<id> and the loop checks it.
//
// Names and descriptions a human wrote live in ~/.minami/automations.json; KNOWN seeds them so the page
// reads well on day one. Deleting a launchd job moves its plist to ~/.minami/automations/trash/ — restorable.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const AGENTS = path.join(HOME, "Library", "LaunchAgents");
const BASE = process.env.MINAMI_AUTOMATIONS_DIR || path.join(HOME, ".minami", "automations");
const META = path.join(BASE, "meta.json");
const PAUSED = path.join(BASE, "paused");
const TRASH = path.join(BASE, "trash");
const PREFIX = "com.thomas.";
const UID = process.getuid?.() ?? 501;
const DOMAIN = `gui/${UID}`;
const LABEL_RE = /^com\.thomas\.[a-z0-9][a-z0-9.-]{0,60}$/;
const PATH_ENV = `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

export type Schedule =
  | { kind: "daily"; at: string }                 // "20:00"
  | { kind: "weekly"; day: number; at: string }   // day 0 = Sunday, as launchd counts
  | { kind: "every"; minutes: number }
  | { kind: "login" }
  | { kind: "always" }
  | { kind: "custom"; text: string };             // anything this page can't edit (several times a day…)

export type Automation = {
  id: string; kind: "launchd" | "inproc"; name: string; description: string; project?: string;
  schedule: Schedule; scheduleText: string; nextRun: string | null;
  command: string; workdir?: string; log?: string;
  status: "running" | "idle" | "paused" | "failing" | "not-loaded";
  pid?: number; lastExit?: number | null; runs?: number; lastRun?: string | null;
  protected?: boolean; host?: string;
  pausedAt?: string | null;   // when it was paused from this page
  upSec?: number | null;      // how long the running process has been up
  lastLine?: string | null;   // the last thing it wrote to its log — the cheapest sign of life there is
};

type Meta = Record<string, { name?: string; description?: string; project?: string; pausedAt?: string }>;

const KNOWN: Meta = {
  "com.thomas.minami-bot": { name: "Minami bot", description: "The Slack bot in both workspaces: captures, recall, ideas, and the video-plan card. Pausing it takes Minami off Slack.", project: "Minami" },
  "com.thomas.minami-heartbeat": { name: "Morning heartbeat", description: "Plans the day: reads the pipelines and project notes, writes /today and the vault daily note.", project: "Minami Dashboard" },
  "com.thomas.minami-login": { name: "Open Minami at login", description: "Starts the dashboard, catches up a missed heartbeat, opens /today.", project: "Minami Dashboard" },
  "com.thomas.minami-morning": { name: "09:00 nudge", description: "A notification and /today opened in the browser.", project: "Minami Dashboard" },
  "com.thomas.minami-today-sync": { name: "Today auto-ticks", description: "Checks the day's to-dos against the repos and ticks the ones that are done.", project: "Minami Dashboard" },
  "com.thomas.minami-vocab": { name: "Vocabulary from the vault", description: "Feeds vault names into the dashboard's speech vocabulary.", project: "Minami Dashboard" },
  "com.thomas.secondbrain-sync": { name: "Vault sync", description: "Commits and pushes the Second Brain so every device has it.", project: "Second Brain" },
  "com.thomas.video-evening": { name: "Video topics — evening plan", description: "Learns from last night's taps, scans AI news, writes tomorrow's 5 topics for the Slack card.", project: "Video Studio" },
  "com.thomas.video-overnight": { name: "Videos — overnight runner", description: "Keeps the Mac awake, waits for the 00:30 lock, then writes, builds, voices and renders every locked video. Progress goes in the card's thread; the morning card comes at 07:00.", project: "Video Studio" },
};
const PROTECTED = new Set(["com.thomas.minami-bot", "com.thomas.secondbrain-sync"]);

// The loops inside other processes. `host` is the launchd job they live in: pausing that pauses them too.
const INPROC: Omit<Automation, "status">[] = [
  { id: "video-plan-card", kind: "inproc", name: "Video topics — Slack card", project: "Video Studio",
    description: "Posts tomorrow's topics to your Ownego DM at 21:30 and locks the plan at 00:30 (silence = go). Inside the Minami bot.",
    schedule: { kind: "custom", text: "21:30 post · 00:30 lock" }, scheduleText: "21:30 post · 00:30 lock", nextRun: null,
    command: "~/Minami/src/videoPlan.js (tick every minute)", host: "com.thomas.minami-bot" },
];

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
const tryRun = (cmd: string, args: string[]) => { try { return sh(cmd, args); } catch (e: any) { return String(e.stdout || "") + String(e.stderr || ""); } };
const plistPath = (label: string) => path.join(AGENTS, `${label}.plist`);
function assertLabel(id: string) { if (!LABEL_RE.test(id)) throw new Error(`not a com.thomas.* job: ${id}`); }
function readMeta(): Meta { try { return JSON.parse(fs.readFileSync(META, "utf8")); } catch { return {}; } }
function writeMeta(m: Meta) { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(META, JSON.stringify(m, null, 2)); }
const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function readPlist(file: string): any {
  return JSON.parse(sh("plutil", ["-convert", "json", "-o", "-", file]));
}

function scheduleOf(p: any): Schedule {
  const c = p.StartCalendarInterval;
  if (c && !Array.isArray(c) && c.Hour !== undefined && c.Day === undefined && c.Month === undefined) {
    const at = `${pad(c.Hour)}:${pad(c.Minute ?? 0)}`;
    return c.Weekday !== undefined ? { kind: "weekly", day: c.Weekday % 7, at } : { kind: "daily", at };
  }
  if (c) return { kind: "custom", text: (Array.isArray(c) ? c : [c]).map((x: any) => `${x.Weekday !== undefined ? DAYS[x.Weekday % 7] + " " : ""}${x.Hour !== undefined ? pad(x.Hour) : "*"}:${pad(x.Minute ?? 0)}`).join(", ") };
  if (p.StartInterval) return { kind: "every", minutes: Math.round(p.StartInterval / 60) };
  if (p.KeepAlive) return { kind: "always" };
  if (p.RunAtLoad) return { kind: "login" };
  return { kind: "custom", text: "on demand" };
}

export function describeSchedule(s: Schedule): string {
  switch (s.kind) {
    case "daily": return `Daily at ${s.at}`;
    case "weekly": return `${DAYS[s.day]}s at ${s.at}`;
    case "every": return s.minutes % 60 === 0 ? `Every ${s.minutes / 60} h` : `Every ${s.minutes} min`;
    case "login": return "At login";
    case "always": return "Always on";
    case "custom": return s.text;
  }
}

function nextRun(s: Schedule, lastRun: string | null): string | null {
  const now = new Date();
  if (s.kind === "daily" || s.kind === "weekly") {
    const [h, m] = s.at.split(":").map(Number);
    const d = new Date(now); d.setHours(h, m, 0, 0);
    if (s.kind === "daily") { if (d <= now) d.setDate(d.getDate() + 1); }
    else { let add = (s.day - d.getDay() + 7) % 7; if (add === 0 && d <= now) add = 7; d.setDate(d.getDate() + add); }
    return d.toISOString();
  }
  if (s.kind === "every") {
    const base = lastRun ? Date.parse(lastRun) : now.getTime();
    return new Date(Math.max(base + s.minutes * 60e3, now.getTime())).toISOString();
  }
  return null;
}

function toCalendar(s: Schedule): Record<string, unknown> {
  // Returns the plist keys for a schedule; the caller clears the others first.
  if (s.kind === "daily" || s.kind === "weekly") {
    const [Hour, Minute] = s.at.split(":").map(Number);
    if (!(Hour >= 0 && Hour < 24 && Minute >= 0 && Minute < 60)) throw new Error(`bad time ${s.at}`);
    return { StartCalendarInterval: s.kind === "weekly" ? { Weekday: s.day, Hour, Minute } : { Hour, Minute } };
  }
  if (s.kind === "every") { if (!(s.minutes >= 1)) throw new Error("every needs minutes ≥ 1"); return { StartInterval: Math.round(s.minutes * 60) }; }
  if (s.kind === "login") return { RunAtLoad: true };
  if (s.kind === "always") return { KeepAlive: true, RunAtLoad: true };
  throw new Error("this schedule can't be set from the page — edit the plist");
}

function launchState(label: string) {
  const out = tryRun("launchctl", ["print", `${DOMAIN}/${label}`]);
  if (/Could not find service|not find/i.test(out) || !out.includes("state =")) return { loaded: false };
  const pid = out.match(/\n\s*pid = (\d+)/)?.[1];
  const exit = out.match(/last exit code = (-?\d+)/)?.[1];
  const runs = out.match(/\n\s*runs = (\d+)/)?.[1];
  return { loaded: true, pid: pid ? Number(pid) : undefined, lastExit: exit !== undefined ? Number(exit) : null, runs: runs ? Number(runs) : 0 };
}

function disabledSet(): Set<string> {
  const out = tryRun("launchctl", ["print-disabled", DOMAIN]);
  return new Set([...out.matchAll(/"([^"]+)" => (?:disabled|true)/g)].map((m) => m[1]));
}

// The last non-empty line of a log, colour codes stripped. Reads only the tail, so a 50 MB log costs nothing.
function lastLineOf(file?: string): string | null {
  if (!file) return null;
  try {
    const fd = fs.openSync(file, "r"); const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 4096); const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const line = buf.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean).pop();
    return line ? line.replaceAll(HOME, "~").slice(0, 180) : null;
  } catch { return null; }
}

// `ps -o etime` is [[dd-]hh:]mm:ss.
function upSeconds(pid?: number): number | null {
  if (!pid) return null;
  const t = tryRun("ps", ["-o", "etime=", "-p", String(pid)]).trim();
  const m = t.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return m ? ((+(m[1] || 0) * 24 + +(m[2] || 0)) * 60 + +m[3]) * 60 + +m[4] : null;
}

function logTime(file?: string): string | null {
  if (!file) return null;
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}

// ── read ───────────────────────────────────────────────────────────────────────────────────────────────────
export function list(): Automation[] {
  const meta = { ...KNOWN, ...readMeta() };
  const disabled = disabledSet();
  const items: Automation[] = [];
  for (const f of fs.existsSync(AGENTS) ? fs.readdirSync(AGENTS) : []) {
    if (!f.startsWith(PREFIX) || !f.endsWith(".plist")) continue;
    const label = f.slice(0, -6);
    let p: any;
    try { p = readPlist(path.join(AGENTS, f)); } catch { continue; }
    const s = scheduleOf(p);
    const st = launchState(label);
    const m = { ...KNOWN[label], ...meta[label] };
    const lastRun = logTime(p.StandardOutPath);
    const args: string[] = p.ProgramArguments ?? (p.Program ? [p.Program] : []);
    const status: Automation["status"] = disabled.has(label) ? "paused" : !st.loaded ? "not-loaded" : st.pid ? "running"
      : st.lastExit && st.lastExit !== 0 ? "failing" : "idle";
    items.push({ id: label, kind: "launchd", name: m.name || label.slice(PREFIX.length), description: m.description || "", project: m.project,
      schedule: s, scheduleText: describeSchedule(s), nextRun: status === "paused" ? null : nextRun(s, lastRun),
      command: args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ").replaceAll(HOME, "~"), workdir: p.WorkingDirectory?.replace(HOME, "~"),
      log: p.StandardOutPath, status, pid: st.pid, lastExit: st.lastExit ?? null, runs: st.runs, lastRun, protected: PROTECTED.has(label),
      pausedAt: status === "paused" ? m.pausedAt ?? null : null, upSec: upSeconds(st.pid), lastLine: lastLineOf(p.StandardOutPath || p.StandardErrorPath) });
  }
  for (const j of INPROC) {
    const host = items.find((i) => i.id === j.host);
    const m = meta[j.id] || {};
    const flag = path.join(PAUSED, j.id);
    const paused = fs.existsSync(flag);
    items.push({ ...j, name: m.name || j.name, description: m.description || j.description,
      pausedAt: paused ? fs.readFileSync(flag, "utf8").trim() || null : null,
      status: paused ? "paused" : !host || host.status === "paused" || host.status === "not-loaded" ? "not-loaded" : "idle" });
  }
  return items;
}

export function logs(id: string, lines = 60): string {
  assertLabel(id);
  const p = readPlist(plistPath(id));
  const file = p.StandardOutPath || p.StandardErrorPath;
  if (!file || !fs.existsSync(file)) return "(no log file)";
  const fd = fs.openSync(file, "r"); const size = fs.fstatSync(fd).size;
  const len = Math.min(size, 16_000); const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
  return buf.toString("utf8").split("\n").slice(-lines).join("\n");
}

// ── write ──────────────────────────────────────────────────────────────────────────────────────────────────
const bootout = (label: string) => tryRun("launchctl", ["bootout", `${DOMAIN}/${label}`]);
const bootstrap = (label: string) => { const out = tryRun("launchctl", ["bootstrap", DOMAIN, plistPath(label)]); if (/error/i.test(out) && !/already/i.test(out)) throw new Error(out.trim()); };

export function pause(id: string) {
  if (INPROC.some((j) => j.id === id)) { fs.mkdirSync(PAUSED, { recursive: true }); fs.writeFileSync(path.join(PAUSED, id), new Date().toISOString()); return; }
  assertLabel(id);
  sh("launchctl", ["disable", `${DOMAIN}/${id}`]);
  bootout(id);
  const meta = readMeta(); meta[id] = { ...meta[id], pausedAt: new Date().toISOString() }; writeMeta(meta);
}

export function resume(id: string) {
  if (INPROC.some((j) => j.id === id)) { fs.rmSync(path.join(PAUSED, id), { force: true }); return; }
  assertLabel(id);
  sh("launchctl", ["enable", `${DOMAIN}/${id}`]);
  bootstrap(id);
  const meta = readMeta(); if (meta[id]) { delete meta[id].pausedAt; writeMeta(meta); }
}

export function runNow(id: string) {
  assertLabel(id);
  if (disabledSet().has(id)) throw new Error("it's paused — resume it first");
  if (!launchState(id).loaded) bootstrap(id);
  sh("launchctl", ["kickstart", `${DOMAIN}/${id}`]);
}

export type Edit = { id: string; name?: string; description?: string; project?: string; schedule?: Schedule; command?: string; workdir?: string };

export function update(e: Edit) {
  const meta = readMeta();
  const cur = meta[e.id] || {};
  for (const k of ["name", "description", "project"] as const) if (e[k] !== undefined) cur[k] = String(e[k]).trim();
  meta[e.id] = cur; writeMeta(meta);
  if (INPROC.some((j) => j.id === e.id)) return;
  assertLabel(e.id);
  if (!e.schedule && e.command === undefined && e.workdir === undefined) return;
  const file = plistPath(e.id);
  const p = readPlist(file);
  if (e.schedule) {
    const keys = toCalendar(e.schedule);
    for (const k of ["StartCalendarInterval", "StartInterval", "KeepAlive", "RunAtLoad"]) delete p[k];
    Object.assign(p, keys);
  }
  if (e.command !== undefined && e.command.trim()) p.ProgramArguments = ["/bin/zsh", "-lc", e.command.trim()];
  if (e.workdir !== undefined) { const w = expand(e.workdir); if (w && !fs.existsSync(w)) throw new Error(`no such folder: ${w}`); if (w) p.WorkingDirectory = w; else delete p.WorkingDirectory; }
  writePlist(file, p);
  reload(e.id);
}

export type Create = { slug: string; name: string; description?: string; project?: string; command: string; workdir?: string; schedule: Schedule };

export function create(c: Create) {
  const label = `${PREFIX}${String(c.slug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "")}`;
  assertLabel(label);
  if (fs.existsSync(plistPath(label))) throw new Error(`${label} already exists`);
  if (!c.command?.trim()) throw new Error("a command is required");
  const wd = expand(c.workdir || "~");
  if (!fs.existsSync(wd)) throw new Error(`no such folder: ${wd}`);
  const log = path.join(HOME, ".minami", "automations", "logs", `${label.slice(PREFIX.length)}.log`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  writePlist(plistPath(label), { Label: label, ProgramArguments: ["/bin/zsh", "-lc", c.command.trim()], WorkingDirectory: wd,
    EnvironmentVariables: { PATH: PATH_ENV }, StandardOutPath: log, StandardErrorPath: log, ...toCalendar(c.schedule) });
  const meta = readMeta(); meta[label] = { name: c.name.trim() || label, description: c.description?.trim() || "", project: c.project?.trim() || undefined }; writeMeta(meta);
  bootstrap(label);
  return label;
}

export function remove(id: string) {
  assertLabel(id);
  if (PROTECTED.has(id)) throw new Error("this one is protected — pause it instead");
  bootout(id);
  fs.mkdirSync(TRASH, { recursive: true });
  fs.renameSync(plistPath(id), path.join(TRASH, `${id}.${Date.now()}.plist`));
}

export function trash(): { file: string; id: string; at: string }[] {
  if (!fs.existsSync(TRASH)) return [];
  return fs.readdirSync(TRASH).filter((f) => f.endsWith(".plist")).map((f) => {
    const m = f.match(/^(.*)\.(\d+)\.plist$/);
    return { file: f, id: m?.[1] ?? f, at: new Date(Number(m?.[2] ?? 0)).toISOString() };
  }).sort((a, b) => b.at.localeCompare(a.at));
}

export function restore(file: string) {
  if (file.includes("/") || !file.endsWith(".plist")) throw new Error("bad file");
  const id = file.replace(/\.\d+\.plist$/, "");
  assertLabel(id);
  if (fs.existsSync(plistPath(id))) throw new Error(`${id} exists again — delete that one first`);
  fs.renameSync(path.join(TRASH, file), plistPath(id));
  bootstrap(id);
}

function expand(p: string) { return p.trim().replace(/^~(?=\/|$)/, HOME); }
function writePlist(file: string, obj: any) {
  const tmp = `${file}.tmp.json`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  sh("plutil", ["-convert", "xml1", "-o", file, tmp]);
  fs.rmSync(tmp, { force: true });
}
function reload(label: string) {
  if (disabledSet().has(label)) return; // paused stays paused; the new plist is read on resume
  bootout(label);
  bootstrap(label);
}
