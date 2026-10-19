// Limit failover (§6b): when a live pane hits its account's usage limit, switch the box to the
// account chosen in Settings (`onLimit` in ~/.minami/account.json) so the pane can carry on.
//
// Why the dashboard does this itself rather than leaving it to token-slayer: token-slayer 1.2.3 has
// its own auto-switch (`auto_switch_on_rate_limit`), but it only works for a `claude` started through
// `tok run`. That wrapper owns the child, listens on a hook signal bus and relaunches with `--resume`.
// Dashboard panes are Agent SDK children of next-server and never go through it, so the limit is
// detected here (lib/agent/manager.ts) and token-slayer only does the switch itself — `tok switch`,
// never `force-switch`, because `switch` captures the rotated refresh token of the slot being left.
//
// Every `tok switch` rewrites the one shared Keychain credential, which is the operation behind the
// "OAuth session expired" clobber (§6, token-slayer skill). Hence: single flight (five panes hitting
// the same limit in the same second make one switch, not five), one hop only (if the fallback is also
// out, stop and say so — never walk the pool), and a switch is believed only once ~/.claude.json says so.
import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, liveIdentity, readOnLimit } from "./preferred-account";
import { runTok, tokStatus, type TokAccount } from "./token-slayer";

export type LimitHit = {
  /** The account the pane was BORN on — not the live one, which another pane may already have moved. */
  hitOn: string | null;
  /** `five_hour` / `seven_day` / … from the SDK's rate_limit_event, when it sent one. */
  type?: string;
  /** Epoch seconds. */
  resetsAt?: number;
  /** The CLI's own words ("You've hit your weekly limit · resets …"), when that is all we have. */
  text?: string;
};

export type Decision =
  | { action: "switch"; to: string; reason: string }
  | { action: "respawn"; reason: string }
  | { action: "none"; reason: string };

/**
 * Pure: what to do about a limit hit. Kept free of I/O so the cases below are testable without a
 * real limit (lib/account-failover.test.mjs).
 */
export function decide(input: { hit: LimitHit; live: string | null; target: string; pool: TokAccount[] }): Decision {
  const { hit, live, target, pool } = input;
  if (!target) return { action: "none", reason: "limit failover is off (no account chosen in Settings)" };
  const hitOn = hit.hitOn ?? live;
  if (hitOn === target) return { action: "none", reason: `${target} — the fallback account itself — hit its limit` };
  // Another pane already moved the box (or someone switched by hand). Don't switch again; just let
  // this pane be reborn on whatever is live now.
  if (live && hitOn && live !== hitOn) return { action: "respawn", reason: `the box is already on ${live}` };
  const slot = pool.find((a) => (a.email || a.name) === target);
  if (!slot) return { action: "none", reason: `${target} isn't in the token-slayer pool — run: tok add ${target} --login` };
  if (slot.state === "reauth" || slot.usage?.token_expired) {
    return { action: "none", reason: `${target} needs signing in again — run: tok add ${target} --login` };
  }
  // Either window full makes the target useless, whichever window the live account ran out of: a 5-hour
  // hit moved onto an account with no weekly left fails on its very first request.
  for (const [w, label] of [["five_hour", "5-hour"], ["seven_day", "weekly"]] as const) {
    const used = slot.usage?.[w];
    if (used && typeof used.utilization === "number" && used.utilization >= 100) {
      return { action: "none", reason: `${target} is at its ${label} limit too` };
    }
  }
  return { action: "switch", to: target, reason: `${hit.type ?? "usage"} limit on ${hitOn ?? "the live account"}` };
}

// ── log ──────────────────────────────────────────────────────────────────────────────────────────
// One line per attempt, including the ones that did nothing: "limit hit, nowhere to go" is the
// case you most need to see, and the alert reads it from here (lastFailover below).
export const LOG_FILE = path.join(path.dirname(CONFIG_FILE), "failover.jsonl");

export type FailoverRecord = {
  at: number;
  hitOn: string | null;
  type?: string;
  resetsAt?: number;
  action: Decision["action"];
  to?: string;
  ok: boolean;
  reason: string;
};

function log(r: FailoverRecord): void {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(r) + "\n", "utf8");
  } catch { /* the log is for the alert, never a reason to fail the switch */ }
}

/** The newest record that switched or failed to, within `maxAgeMs`. `respawn` lines are skipped: they
 *  are a pane catching up with a switch already logged, not a new event. */
export function lastFailover(maxAgeMs = 12 * 3600_000): FailoverRecord | null {
  let text = "";
  try { text = fs.readFileSync(LOG_FILE, "utf8"); } catch { return null; }
  const lines = text.trimEnd().split("\n").slice(-50).reverse();
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as FailoverRecord;
      if (r.action === "respawn") continue;
      return Date.now() - r.at <= maxAgeMs ? r : null;
    } catch { /* torn line */ }
  }
  return null;
}

// ── act ──────────────────────────────────────────────────────────────────────────────────────────

/** Exit 0 from `tok switch` is not proof (§6: its state file records intent, not outcome). Wait for
 *  Claude Code's own record of who it is logged in as. */
async function waitForLive(email: string, timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (liveIdentity().email === email) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return liveIdentity().email === email;
}

let inflight: Promise<unknown> | null = null;

/**
 * Handle one pane's limit hit. Concurrent callers queue behind the one in flight and then decide
 * again — by then the live account has moved, so they take the `respawn` branch instead of switching
 * a second time.
 *
 * Resolves `ok: true` when the pane should be reborn and continued (a switch that verified, or a box
 * that had already moved); `ok: false` means leave the pane alone, and `reason` says why.
 */
export async function onLimitHit(hit: LimitHit): Promise<{ ok: boolean; decision: Decision }> {
  while (inflight) await inflight.catch(() => {});
  const run = (async () => {
    const target = readOnLimit();
    const live = liveIdentity().email;
    // Only pay for `tok status` (a few hundred ms, network for usage) when a switch is possible.
    const needPool = !!target && (hit.hitOn ?? live) !== target && !(live && hit.hitOn && live !== hit.hitOn);
    const pool = needPool ? (await tokStatus())?.accounts ?? [] : [];
    const decision = decide({ hit, live, target, pool });
    const base = { at: Date.now(), hitOn: hit.hitOn ?? live, type: hit.type, resetsAt: hit.resetsAt };
    if (decision.action === "none") {
      log({ ...base, action: "none", ok: false, reason: decision.reason });
      return { ok: false, decision };
    }
    if (decision.action === "respawn") {
      log({ ...base, action: "respawn", to: live ?? undefined, ok: true, reason: decision.reason });
      return { ok: true, decision };
    }
    const r = await runTok(["switch", decision.to]);
    const verified = r.ok && (await waitForLive(decision.to));
    const reason = verified
      ? decision.reason
      : r.ok
        ? `tok switch reported success but Claude Code is still on ${liveIdentity().email ?? "an unknown account"}`
        : `tok switch failed: ${(r.stderr || "").trim().split("\n").pop()}`;
    log({ ...base, action: "switch", to: decision.to, ok: verified, reason });
    return { ok: verified, decision: verified ? decision : { action: "none" as const, reason } };
  })();
  inflight = run;
  try { return await run; } finally { if (inflight === run) inflight = null; }
}

/** The limit text the CLI writes into a synthetic assistant message. A plain 429 or `overloaded` is
 *  transient and must not move the box, so the SDK's `error: "rate_limit"` alone is not enough. */
export const LIMIT_TEXT = /hit your (?:weekly|session|daily|usage|opus|sonnet)?\s*limit|usage limit reached/i;
