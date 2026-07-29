import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const PREFERRED = process.env.MINAMI_PREFERRED_ACCOUNT || "oedevai2@gmail.com";

// Ground truth for "which account is Claude Code ACTUALLY authenticated as".
//
// This is deliberately NOT `token-slayer status`'s `active` field: that only echoes `active_slot`
// from ~/.config/token_slayer/state.json, which is a label token-slayer writes when you ask it to
// switch — not proof the switch took. Verified 2026-07-29: state.json said `oedevai2@gmail.com`
// while the real OS-keychain credential belonged to `pdtoan2811@gmail.com`, so every session was
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
      // NB: displayName is cosmetic and demonstrably goes stale across switches (it read "OE Dev"
      // while every UUID said pdtoan2811) — never key logic off it, it's here for display only.
      displayName: o.displayName ?? null,
    };
  } catch {
    return { email: null, orgUuid: null, displayName: null };
  }
}

// GET /api/accounts → the account pool + live usage, straight from `token-slayer status --json`,
// plus a `live` block carrying the real authenticated identity (see liveIdentity above).
export async function GET() {
  const { ok, stdout, stderr } = await run(["status", "--json"]);
  if (!ok) return Response.json({ error: stderr || "token-slayer status failed" }, { status: 502 });
  try {
    const doc = JSON.parse(stdout);
    const live = liveIdentity();
    return Response.json({
      ...doc,
      live: {
        ...live,
        preferred: PREFERRED,
        // The alert's trigger: we know who we really are, and it isn't who we want to be.
        offPreferred: live.email != null && live.email !== PREFERRED,
        // The CLI's own banner disagreeing with reality — worth surfacing separately, because it
        // means "just switch back" may report success without actually changing anything.
        claimsMismatch: live.email != null && typeof doc?.active === "string" && doc.active !== live.email,
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
