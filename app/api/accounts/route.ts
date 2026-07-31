import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkModelPins } from "@/lib/model-pins";
import { readPreferred, writePreferred, isPinned } from "@/lib/preferred-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Local-only bridge to the `token-slayer` CLI (Claude Max account-slot switcher). Prefers the venv
// binary it installs itself; falls back to whatever `token-slayer` resolves to on PATH.
const VENV_BIN = path.join(os.homedir(), ".config", "token_slayer", "venv", "bin", "token-slayer");
const BIN = fs.existsSync(VENV_BIN) ? VENV_BIN : "token-slayer";

function run(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(BIN, args, { timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || String(err?.message || "") });
    });
  });
}

// The account we WANT to be running on. Falling off it is what the alert exists to catch.
// Chosen in Settings and stored on disk — see lib/preferred-account.ts for why it can't be a
// `useSetting`. Read per-request so a change in the UI lands on the next 30s poll.

// Ground truth for "which account is Claude Code ACTUALLY authenticated as".
//
// This is deliberately NOT `token-slayer status`'s `active` field: that only echoes `active_slot`
// from ~/.config/token_slayer/state.json, which is a label token-slayer writes when you ask it to
// switch — not proof the switch took. Verified 2026-07-29: state.json named one pooled account
// while the real OS-keychain credential belonged to a different one, so every session was
// silently billing the wrong account while the CLI's banner claimed otherwise. ~/.claude.json's
// `oauthAccount` block is written by Claude Code itself from the credential it actually logged in
// with, so it can't drift the same way. See the vault's [[Token Slayer]] note.
function liveIdentity(): { email: string | null; orgUuid: string | null; displayName: string | null } {
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

// GET /api/accounts → the account pool + live usage, straight from `token-slayer status --json`,
// plus a `live` block carrying the real authenticated identity (see liveIdentity above) and the
// model-pin drift check.
//
// Both drift signals ride this one route on purpose: the alert component polls it every 30s, and
// "which account am I burning" and "which model am I burning it on" are the same question asked
// twice. Splitting them into two routes would double the poll for no gain.
export async function GET() {
  const { ok, stdout, stderr } = await run(["status", "--json"]);
  if (!ok) return Response.json({ error: stderr || "token-slayer status failed" }, { status: 502 });
  try {
    const doc = JSON.parse(stdout);
    const live = liveIdentity();
    const preferred = readPreferred();
    return Response.json({
      ...doc,
      live: {
        ...live,
        preferred,
        // Whether someone actually chose it, vs. it being the shipped fallback. Settings shows
        // this so an unpinned default doesn't masquerade as a deliberate decision.
        preferredPinned: isPinned(),
        // The alert's trigger: we know who we really are, and it isn't who we want to be.
        //
        // `preferred` is empty until someone chooses one (the shipped default is deliberately blank
        // — see lib/preferred-account.ts), and with no preferred account there is no such thing as
        // being off it. Without this guard a fresh clone alerts forever against "", which reads as
        // "you are on the wrong account" to someone who has not yet been asked which account is right.
        offPreferred: preferred !== "" && live.email != null && live.email !== preferred,
        // The CLI's own banner disagreeing with reality — worth surfacing separately, because it
        // means "just switch back" may report success without actually changing anything.
        claimsMismatch: live.email != null && typeof doc?.active === "string" && doc.active !== live.email,
        // What each spawner will run on its NEXT turn, and whether any has fallen off the pin.
        models: checkModelPins(),
      },
    });
  } catch {
    return Response.json({ error: "unparsable token-slayer output" }, { status: 502 });
  }
}

// POST /api/accounts { target } → switch the active Claude account slot.
export async function POST(req: Request) {
  let target = "";
  try { ({ target } = await req.json()); } catch { /* bad body */ }
  if (!target || typeof target !== "string") {
    return Response.json({ error: "missing target" }, { status: 400 });
  }
  const { ok, stdout, stderr } = await run(["switch", target]);
  if (!ok) return Response.json({ error: stderr || "switch failed" }, { status: 502 });
  return Response.json({ ok: true, output: stdout });
}

// PUT /api/accounts { preferred } → change which account the alert measures against.
//
// Deliberately separate from POST: POST *switches the live credential* (a side effect that kills
// every running `claude` on the box), PUT only records an intention. Conflating them would mean
// picking a target in Settings silently rewrote the Keychain and dropped your sessions.
export async function PUT(req: Request) {
  let preferred = "";
  try { ({ preferred } = await req.json()); } catch { /* bad body */ }
  if (!preferred || typeof preferred !== "string") {
    return Response.json({ error: "missing preferred" }, { status: 400 });
  }

  // Only accept an account token-slayer actually manages. A typo'd address would otherwise pin
  // the alert to an account that can never be live, leaving it stuck red with no way to read why.
  const { ok, stdout } = await run(["status", "--json"]);
  if (ok) {
    try {
      const doc = JSON.parse(stdout);
      const pool: string[] = (doc?.accounts ?? [])
        .map((a: { email?: string; name?: string }) => a.email || a.name)
        .filter((e: unknown): e is string => typeof e === "string" && e.length > 0);
      if (pool.length && !pool.includes(preferred)) {
        return Response.json(
          { error: `"${preferred}" is not in the token-slayer pool`, pool },
          { status: 400 }
        );
      }
    } catch { /* unparsable status — don't block the write on it */ }
  }

  try {
    writePreferred(preferred);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
  return Response.json({ ok: true, preferred: readPreferred(), preferredPinned: isPinned() });
}
