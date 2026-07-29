import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { drainForRestart, liveStats } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Restart-safety endpoint for bin/serve.sh — see the "Restart safety" block in lib/agent/manager.ts.
//
//   GET  /api/agent/health         → { sessions, busy, details[] }  "what would a restart destroy?"
//   POST /api/agent/health {drain} → warn every pane, wait for in-flight turns, report if it went quiet
//
// AUTH: a shared secret in a 0600 file, NOT a header check.
//
// `next start` binds 0.0.0.0 (the boot log advertises the LAN address so the phone view works), so
// without a gate anything on the Wi-Fi could stall every chat on the box by POSTing a drain. The
// obvious gate — "is this request from loopback?" — cannot be built from headers here:
//
//   1. A Next route handler has no access to the peer socket address.
//   2. Next's base-server does `req.headers['x-forwarded-for'] ??= socket.remoteAddress`, so the header
//      is ALWAYS present (its absence never means "local") — the first version of this file treated
//      presence as proof of a proxy hop and 403'd its own loopback caller.
//   3. `??=` only fills the header when the client omitted it, so a LAN client can simply SEND
//      `x-forwarded-for: 127.0.0.1` and have Next preserve it. Host is equally forgeable with `curl -H`.
//
// So the only thing that actually distinguishes "allowed" from "not" is possession of a secret that
// requires filesystem access to this machine to read — which is exactly the privilege level already
// needed to run bin/serve.sh. Fails closed: no token file, no access.
const TOKEN_FILE = path.join(process.cwd(), ".minami-drain-token");

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak length via the error path —
  // compare lengths first and still run the digest on equal-length input only.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function authorized(req: Request): Promise<boolean> {
  const presented = req.headers.get("x-minami-drain-token");
  if (!presented) return false;
  try {
    const expected = (await readFile(TOKEN_FILE, "utf8")).trim();
    if (!expected) return false;
    return constantTimeEqual(presented, expected);
  } catch {
    return false; // no token file provisioned — deny rather than fall open
  }
}

export async function GET(req: Request) {
  if (!(await authorized(req))) return Response.json({ error: "unauthorized" }, { status: 403 });
  try {
    return Response.json(liveStats());
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!(await authorized(req))) return Response.json({ error: "unauthorized" }, { status: 403 });
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action !== "drain") return Response.json({ error: "unknown action" }, { status: 400 });
    // Clamped: this call blocks the deploy script, so an absurd timeout from a typo shouldn't be able to
    // wedge it indefinitely — the script has its own escalation path once this returns.
    const timeoutMs = Math.min(300_000, Math.max(0, Number(body?.timeoutMs) || 60_000));
    const result = await drainForRestart(timeoutMs);
    return Response.json({ ok: true, ...result, after: liveStats() });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
