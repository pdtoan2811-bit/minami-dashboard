// Local-only bridge to the `token-slayer` CLI (Claude Max account-slot switcher). Shared by
// /api/accounts and the limit failover (lib/account-failover.ts) so both call the same binary.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Prefers the venv binary it installs itself; falls back to whatever `token-slayer` resolves to on PATH.
const VENV_BIN = path.join(os.homedir(), ".config", "token_slayer", "venv", "bin", "token-slayer");
const BIN = fs.existsSync(VENV_BIN) ? VENV_BIN : "token-slayer";

export function runTok(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(BIN, args, { timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || String(err?.message || "") });
    });
  });
}

/** One usage window as `tok status --json` reports it: utilization is a percentage (0–100). */
export type TokWindow = { utilization: number; resets_at?: number } | null;

export type TokAccount = {
  email?: string;
  name?: string;
  state?: string;
  active?: boolean;
  usage?: { five_hour?: TokWindow; seven_day?: TokWindow; token_expired?: boolean; [k: string]: unknown };
};

export async function tokStatus(): Promise<{ accounts: TokAccount[]; active?: string } | null> {
  const { ok, stdout } = await runTok(["status", "--json"]);
  if (!ok) return null;
  try { return JSON.parse(stdout); } catch { return null; }
}
