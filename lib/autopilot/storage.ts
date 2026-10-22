// Autopilot's `storage` duty (§32): decides WHEN the janitor runs; bin/janitor.mjs decides WHAT goes.
//
// The split is the lesson of the night five renders failed at 3.3 GB free: the only cleanup that ran was a
// project's own tidy inside another job, it freed 0.0 GB, and nothing anywhere said so. So the deleting lives
// in a plain script that a launchd job also runs nightly (the server restarts on every deploy and can't be the
// only clock), and this module adds the two things only an always-on process can: a free-space watermark
// checked every tick, and a dead-man's switch on the janitor itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const HOME = os.homedir();
export const JANITOR_DIR = process.env.MINAMI_JANITOR_DIR || path.join(HOME, ".minami", "janitor");
const CONFIG = path.join(HOME, ".minami", "janitor.json");
const GB = 2 ** 30;
// A pass that just ran and freed little would otherwise be restarted every 45 s while the disk stays low.
const RESPAWN_MS = 20 * 60_000;
// The nightly job runs at 00:15; 26 h allows for a Mac that slept through it and caught up on wake.
const STALE_MS = 26 * 3600_000;

export type JanitorRun = {
  at: string; run: string; why: string; dry?: boolean; watchOnly?: boolean; error?: string;
  freeBeforeGB?: number; freeAfterGB?: number; freedGB?: number; actions?: number; errors?: string[]; ms?: number;
};
export type LedgerLine = { at: string; tier: number; kind: string; path: string; bytes: number; why: string; restore?: string };
export type DiskSample = { date: string; at: string; freeGB: number; top: { path: string; gb: number }[] };
export type Ask = { id: string; title: string; detail: string; gb: number; action?: string };

export function thresholds() {
  let c: Record<string, unknown> = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { /* defaults */ }
  const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  // Same defaults as bin/janitor.mjs — kept by hand; the script is the authority, this only reads.
  return { lowGB: n(c.lowGB, 60), targetGB: n(c.targetGB, 80), criticalGB: n(c.criticalGB, 25) };
}

export function disk() {
  const s = fs.statfsSync(process.platform === "darwin" ? "/System/Volumes/Data" : "/");
  return { freeGB: (s.bavail * s.bsize) / GB, totalGB: (s.blocks * s.bsize) / GB };
}

function jsonl<T>(file: string, last: number): T[] {
  try {
    const lines = fs.readFileSync(path.join(JANITOR_DIR, file), "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-last).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });
  } catch { return []; }
}

export function running(): { pid: number; why: string; at: number } | null {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(JANITOR_DIR, "run.lock"), "utf8"));
    process.kill(l.pid, 0);
    return l;
  } catch { return null; }
}

/** The last pass that really ran (not a dry run, not a crash). The dead-man's switch keys off this. */
export function lastGoodRun(): JanitorRun | null {
  return jsonl<JanitorRun>("runs.jsonl", 200).filter((r) => !r.dry && !r.error).at(-1) ?? null;
}

export function snapshot() {
  const asks = (() => { try { return JSON.parse(fs.readFileSync(path.join(JANITOR_DIR, "asks.json"), "utf8")); } catch { return null; } })();
  const good = lastGoodRun();
  return {
    ...disk(),
    thresholds: thresholds(),
    running: running(),
    lastGood: good,
    stale: !good || Date.now() - Date.parse(good.at) > STALE_MS,
    runs: jsonl<JanitorRun>("runs.jsonl", 30).reverse(),
    ledger: jsonl<LedgerLine>("ledger.jsonl", 60).reverse(),
    samples: jsonl<DiskSample>("disk.jsonl", 30),
    asks: (asks?.asks ?? []) as Ask[],
  };
}

/** Start a pass, detached: a pass can take minutes, and the deploy that kills this server must not kill it. */
export function startJanitor(root: string, args: string[]): boolean {
  if (running()) return false;
  const p = spawn(process.execPath, [path.join(root, "bin", "janitor.mjs"), ...args], {
    cwd: root, detached: true, stdio: "ignore",
  });
  p.unref();
  return true;
}

let lastSpawn = 0;
let lastStaleAlarm = 0;

/** One tick of the duty. Cheap: one statfs and two small file reads, unless it decides to start a pass. */
export async function storageTick(root: string, emit: (kind: string, level: string, title: string, body?: string) => Promise<void>) {
  const { freeGB } = disk();
  const t = thresholds();
  if (freeGB < t.lowGB && !running() && Date.now() - lastSpawn > RESPAWN_MS) {
    lastSpawn = Date.now();
    startJanitor(root, ["--why", "watermark"]);
  }
  // The dead-man's switch. Its own timer, not the shared complain() one, so a chatty merge state can't mute it.
  const good = lastGoodRun();
  if ((!good || Date.now() - Date.parse(good.at) > STALE_MS) && Date.now() - lastStaleAlarm > 6 * 3600_000) {
    lastStaleAlarm = Date.now();
    await emit("storage", "warn", "The storage janitor hasn't run in over a day",
      `Last good pass: ${good ? good.at : "never"}. Check the "Storage janitor" runner on /autopilot?tab=runners ` +
      `(launchd com.thomas.minami-janitor) — ${freeGB.toFixed(1)} GB free now.`);
  }
}
