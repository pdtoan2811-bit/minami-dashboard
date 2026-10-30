#!/usr/bin/env node
// minami-heal — the runners' morning-after pass (2026-10-30). Runs every 30 min as com.thomas.minami-heal.
//
//   node bin/minami-heal.mjs           a pass: re-run what is safe to, list what needs Thomas, write heal.json
//   node bin/minami-heal.mjs --dry     print what a pass would do; starts nothing
//
// WHY: minami-run now stops hung runs (maxSecs), retries safe crashes once and labels Claude-limit failures (see
// SELF-HEALING in bin/minami-run). Two holes are left that a single run can't close on its own:
//   1 · a run that hit the Claude limit has to run again AFTER the reset, hours later;
//   2 · a scheduled run that never started (the Mac off past a whole window, a hang before maxSecs existed).
// For each, a runner with `retry: true` in ~/.minami/automations/meta.json is started again with
// `launchctl kickstart`, so it goes through its plist and minami-run like any run. Anything else — the posting,
// spending, PR-opening runners — is never started here; it is written to heal.json's `needsYou` instead, which
// the Runners tab shows. heal.jsonl keeps every action, so "healed today" can be counted.
//
// Never touches a paused runner (launchctl disabled) or one that is running (its lock's pid is alive).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const MINAMI = path.join(HOME, ".minami");
const RUNS = process.env.MINAMI_RUNS_FILE || path.join(MINAMI, "runs.jsonl");
const META = process.env.MINAMI_META_FILE || path.join(MINAMI, "automations", "meta.json");
const LOCKS = process.env.MINAMI_LOCKS_DIR || path.join(HOME, ".harness", "locks");
const AGENTS = path.join(HOME, "Library", "LaunchAgents");
const STATE = path.join(MINAMI, "heal.json");
const LOG = path.join(MINAMI, "heal.jsonl");
const DOMAIN = `gui/${process.getuid()}`;
const DRY = process.argv.includes("--dry");
const GRACE_MIN = 20;          // a scheduled run that hasn't started 20 min after its time is missed
const LIMIT_FALLBACK_H = 5;    // when the limit line names no reset time
const now = new Date();

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } };
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// ── what each runner last did ─────────────────────────────────────────────────────────────────────────────────
// Only the tail matters: the newest start and end per id.
function lastRuns() {
  let text = "";
  try {
    const fd = fs.openSync(RUNS, "r"), size = fs.fstatSync(fd).size, n = Math.min(size, 2_000_000);
    const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd); text = buf.toString("utf8");
  } catch {}
  const by = {};
  for (const l of text.split("\n")) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    const s = (by[r.id] ??= {});
    if (r.event === "start") s.start = r;
    if (r.event === "end") s.end = r;
  }
  return by;
}

function plist(label) {
  const out = sh("plutil", ["-convert", "json", "-o", "-", path.join(AGENTS, `${label}.plist`)]);
  try { return JSON.parse(out); } catch { return null; }
}

function disabled() {
  const out = sh("launchctl", ["print-disabled", DOMAIN]);
  return new Set([...out.matchAll(/"([^"]+)" => (?:disabled|true)/g)].map((m) => m[1]));
}

function running(label) {
  const lock = readJSON(path.join(LOCKS, `run-${label}.lock`), null);
  return !!(lock?.pid && alive(lock.pid));
}

// The newest time at or before `t` that a StartCalendarInterval fires (local time, as launchd counts).
// Weekday 0 and 7 are both Sunday. Looks back at most 8 days.
function lastFire(cal, t) {
  const entries = (Array.isArray(cal) ? cal : [cal]).filter(Boolean);
  const d = new Date(t); d.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++, d.setMinutes(d.getMinutes() - 1)) {
    for (const e of entries) {
      if (e.Minute !== undefined && e.Minute !== d.getMinutes()) continue;
      if (e.Hour !== undefined && e.Hour !== d.getHours()) continue;
      if (e.Day !== undefined && e.Day !== d.getDate()) continue;
      if (e.Month !== undefined && e.Month !== d.getMonth() + 1) continue;
      if (e.Weekday !== undefined && e.Weekday % 7 !== d.getDay()) continue;
      return new Date(d);
    }
  }
  return null;
}

// "resets 1pm", "resets 1:30 pm", "resets at 13:00" → the next such local time after the failure; else +5 h.
function resetTime(line, failedAt) {
  const m = String(line).match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return new Date(failedAt.getTime() + LIMIT_FALLBACK_H * 3600e3);
  let h = Number(m[1]) % 12; if (!m[3] && Number(m[1]) >= 12) h = Number(m[1]);
  if (m[3]?.toLowerCase() === "pm") h += 12;
  const r = new Date(failedAt); r.setHours(h, Number(m[2] || 0), 0, 0);
  if (r <= failedAt) r.setDate(r.getDate() + 1);
  return new Date(r.getTime() + 5 * 60e3); // a few minutes past, so the quota is really back
}

// ── the pass ──────────────────────────────────────────────────────────────────────────────────────────────────
const meta = readJSON(META, {});
const runs = lastRuns();
const off = disabled();
const labels = fs.readdirSync(AGENTS).filter((f) => /^com\.thomas\..+\.plist$/.test(f)).map((f) => f.slice(0, -6));
const healed = [], needsYou = [];

for (const label of labels) {
  if (label === "com.thomas.minami-heal" || off.has(label)) continue;
  const p = plist(label); if (!p) continue;
  if (p.KeepAlive || running(label)) continue;
  const safe = meta[label]?.retry === true;
  const r = runs[label] || {};
  const lastStart = r.start ? new Date(r.start.start) : null;
  let why = null;

  // 1 · the last run ended on the Claude limit, and nothing has run since.
  if (r.end?.reason === "limit" && r.end.start === r.start?.start) {
    const at = resetTime(r.end.last_line, new Date(r.end.end));
    if (now < at) continue; // still waiting on the limit — not a problem yet
    why = `hit the Claude limit at ${new Date(r.end.end).toLocaleString()}; the limit has reset`;
  }

  // 2 · a scheduled run that never started.
  if (!why && p.StartCalendarInterval) {
    const fire = lastFire(p.StartCalendarInterval, new Date(now.getTime() - GRACE_MIN * 60e3));
    if (fire && (!lastStart || lastStart < new Date(fire.getTime() - 60e3)))
      why = `missed its ${fire.toLocaleString()} run`;
  } else if (!why && p.StartInterval && lastStart) {
    if (now - lastStart > 3 * p.StartInterval * 1000 + GRACE_MIN * 60e3)
      why = `no run for ${Math.round((now - lastStart) / 60e3)} min (runs every ${Math.round(p.StartInterval / 60)})`;
  }
  if (!why) continue;

  const name = meta[label]?.name || label.replace("com.thomas.", "");
  if (safe) {
    if (!DRY) sh("launchctl", ["kickstart", `${DOMAIN}/${label}`]);
    healed.push({ id: label, name, why, at: now.toISOString() });
  } else {
    needsYou.push({ id: label, name, why });
  }
}

const line = (o) => JSON.stringify(o) + "\n";
if (DRY) {
  console.log(JSON.stringify({ healed, needsYou }, null, 2));
} else {
  for (const h of healed) fs.appendFileSync(LOG, line({ ...h, action: "kickstart" }));
  fs.writeFileSync(STATE, JSON.stringify({ at: now.toISOString(), healed, needsYou }, null, 2));
  console.log(`healed ${healed.length} · needs you ${needsYou.length}` +
    [...healed.map((h) => `\n  ↻ ${h.name}: ${h.why}`), ...needsYou.map((n) => `\n  ! ${n.name}: ${n.why}`)].join(""));
}
