// Autopilot's settings — on DISK, not in localStorage, and that is the whole point.
//
// Every other preference in Bento is a `useSetting` (localStorage, per browser). This one cannot be:
// the thing that reads it is a timer inside next-server, which has no browser to ask. It also has to
// survive the restart that the autopilot itself causes — it merges, it deploys, the deploy kills the
// server, and the next process has to come back knowing whether it was switched on. A file does both.
//
// Read fresh on every tick rather than cached: turning it OFF has to take effect on the next tick, not
// on the next restart. That is the only control a nervous user has, so it must be instant.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AutopilotConfig = {
  /** Master switch. OFF is the shipped default and the only safe default — see docs/KNOWLEDGE.md. */
  enabled: boolean;
  /** Merge a ready task without being asked. */
  merge: boolean;
  /** Deploy after a merge lands. Pointless without `merge`, so it's gated on it at the call site. */
  deploy: boolean;
  /** Try to resolve a merge conflict with an agent. When false, a conflict is aborted and reported. */
  resolve: boolean;
  /** How long a task must sit still after its last commit before it counts as finished, ms. */
  settleMs: number;
  /** Tick interval, ms. */
  everyMs: number;
};

export const DEFAULTS: AutopilotConfig = {
  enabled: false, // ← never ship this true
  merge: true,
  deploy: true,
  resolve: true,
  // Two minutes: long enough that a run of commits a few seconds apart reads as one piece of work,
  // short enough that "I'm done" doesn't feel like it went unnoticed.
  settleMs: 120_000,
  everyMs: 45_000,
};

export const CONFIG_FILE =
  process.env.MINAMI_AUTOPILOT_CONFIG || path.join(os.homedir(), ".minami", "autopilot.json");

export function readConfig(): AutopilotConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Partial<AutopilotConfig>;
    // Merge over defaults rather than trusting the file's shape: a hand-edited or half-written file
    // must degrade to "off-ish and sane", never to `undefined` flowing into a `git merge`.
    return {
      ...DEFAULTS,
      ...raw,
      enabled: raw.enabled === true, // only an explicit true switches it on
      settleMs: clamp(raw.settleMs, 10_000, 3_600_000, DEFAULTS.settleMs),
      everyMs: clamp(raw.everyMs, 15_000, 600_000, DEFAULTS.everyMs),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(patch: Partial<AutopilotConfig>): AutopilotConfig {
  const next = { ...readConfig(), ...patch, enabled: (patch.enabled ?? readConfig().enabled) === true };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}

function clamp(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
