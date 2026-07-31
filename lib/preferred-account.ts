// Which Claude account every session is SUPPOSED to be billing.
//
// On disk, not in localStorage, for the same reason as lib/autopilot/config.ts: the thing that
// reads it is /api/accounts inside next-server, which has no browser to ask. `AccountStatus` is
// mounted globally in app/layout.tsx and polls that route every 30s to decide whether to raise
// the wrong-account alert — so the value has to be readable server-side, and it has to survive
// a restart.
//
// Read fresh on every request rather than cached: changing the preferred account in Settings has
// to take effect on the next poll, not on the next deploy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_FILE =
  process.env.MINAMI_ACCOUNT_CONFIG || path.join(os.homedir(), ".minami", "account.json");

/**
 * Deliberately EMPTY, and it must stay that way: this file is checked in, so any address written
 * here ships to every clone. It used to name the author's account, which meant a stranger's first
 * run raised a permanent wrong-account alert measured against an email they've never heard of —
 * an alarm nobody can clear because the "correct" account isn't theirs to log into.
 *
 * Empty means the check is DORMANT, not broken (see `offPreferred` in app/api/accounts/route.ts):
 * with no preferred account there is no such thing as being off it. Pick one in Settings, or set
 * `MINAMI_PREFERRED_ACCOUNT`, and the alert arms itself.
 *
 * This costs the author nothing, because a real choice was never stored here — it lives in
 * `~/.minami/account.json`, outside the repo, which is exactly where a personal answer belongs.
 */
export const FALLBACK = "";

type Stored = { preferred?: string };

/**
 * Precedence: the file wins, then `MINAMI_PREFERRED_ACCOUNT`, then the fallback.
 *
 * The file is deliberately FIRST. The obvious alternative — env var wins — makes the Settings
 * control silently do nothing on any machine that happens to set the var, which is the kind of
 * dead switch that costs an hour to diagnose. Here the env var is a seed for a fresh install,
 * and the moment you pick an account in the UI your choice is the answer.
 */
export function readPreferred(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Stored;
    const v = typeof raw?.preferred === "string" ? raw.preferred.trim() : "";
    if (v) return v;
  } catch {
    /* no file yet, or unreadable — fall through to the env/default chain */
  }
  const fromEnv = (process.env.MINAMI_PREFERRED_ACCOUNT || "").trim();
  return fromEnv || FALLBACK;
}

/** True when the value came from the file, i.e. someone actually chose it. */
export function isPinned(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Stored;
    return typeof raw?.preferred === "string" && raw.preferred.trim() !== "";
  } catch {
    return false;
  }
}

export function writePreferred(email: string): void {
  const preferred = email.trim();
  if (!preferred) throw new Error("preferred account must not be empty");
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  // Write-then-rename so an interrupted write can't leave a truncated file that reads as
  // "nothing chosen" and silently reverts the alert to the fallback account.
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ preferred }, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, CONFIG_FILE);
}
