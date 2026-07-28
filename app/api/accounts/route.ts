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

// GET /api/accounts → the account pool + live usage, straight from `token-slayer status --json`.
export async function GET() {
  const { ok, stdout, stderr } = await run(["status", "--json"]);
  if (!ok) return Response.json({ error: stderr || "token-slayer status failed" }, { status: 502 });
  try {
    return Response.json(JSON.parse(stdout));
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
