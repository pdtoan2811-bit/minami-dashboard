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

/** `onLimit` is the account the limit failover switches to (lib/account-failover.ts). Absent or
 *  empty = the failover is off. Lives in the same file because it is the same kind of fact — a
 *  personal answer about which account this box should be on — and Settings edits both. */
type Stored = { preferred?: string; onLimit?: string };

function readStored(): Stored {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return raw && typeof raw === "object" ? (raw as Stored) : {};
  } catch {
    return {};
  }
}

// Merge, never replace: the file holds two independent choices, and saving one from Settings must
// not silently erase the other. Write-then-rename so an interrupted write can't leave a truncated
// file that reads as "nothing chosen" and silently reverts the alert to the fallback account.
function writeStored(patch: Stored): void {
  const next: Stored = { ...readStored(), ...patch };
  for (const k of Object.keys(next) as (keyof Stored)[]) if (!next[k]) delete next[k];
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, CONFIG_FILE);
}

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
  writeStored({ preferred });
}

/** The account to switch to when a usage limit is hit, or "" when the failover is off. No env
 *  seed and no fallback, on purpose: this rewrites the shared Keychain credential, so it only ever
 *  runs because someone chose it. */
export function readOnLimit(): string {
  const v = readStored().onLimit;
  return typeof v === "string" ? v.trim() : "";
}

/** "" turns the failover off. */
export function writeOnLimit(email: string): void {
  writeStored({ onLimit: email.trim() });
}

// Ground truth for "which account is Claude Code ACTUALLY authenticated as".
//
// This is deliberately NOT `token-slayer status`'s `active` field: that only echoes `active_slot`
// from ~/.config/token_slayer/state.json, which is a label token-slayer writes when you ask it to
// switch — not proof the switch took. Verified 2026-07-29: state.json named one pooled account
// while the real OS-keychain credential belonged to a different one, so every session was
// silently billing the wrong account while the CLI's banner claimed otherwise. ~/.claude.json's
// `oauthAccount` block is written by Claude Code itself from the credential it actually logged in
// with, so it can't drift the same way. See the vault's [[Token Slayer]] note.
export function liveIdentity(): { email: string | null; orgUuid: string | null; displayName: string | null } {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8");
    const o = JSON.parse(raw)?.oauthAccount ?? {};
    return {
      email: o.emailAddress ?? null,
      orgUuid: o.organizationUuid ?? null,
      // NB: displayName is cosmetic and demonstrably goes stale across switches (observed reading
      // the PREVIOUS account's name while every UUID said the new one) — never key logic off it,
      // it's here for display only.
      displayName: o.displayName ?? null,
    };
  } catch {
    return { email: null, orgUuid: null, displayName: null };
  }
}
