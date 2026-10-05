// The tailnet address of a localhost port (§23) — so a `http://localhost:3021` link in a chat can be
// opened from the phone the chat is being read on.
//
// The dashboard reaches a phone through `tailscale serve` (HTTPS, tailnet-only), and a dev server on
// another port is reachable the same way once it has its own serve entry:
// `https://<host>.ts.net:<port>` → `http://127.0.0.1:<port>`. Without this, every localhost link in a
// reply opened the PHONE's own localhost — a dead tab, and nothing on screen said why.
//
// Never `funnel`. Serve is tailnet-only; funnel is the public internet. The dashboard is
// unauthenticated and runs bypassPermissions, and the dev servers it points at are no safer — anyone
// on the tailnet can already drive the dashboard, so a serve entry for a dev port widens nothing, while
// a funnel entry would publish it.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Node's execFile sees no shell aliases, and on this box `tailscale` in a shell IS an alias to the
// app bundle's CLI (the Homebrew daemon was removed — two daemons at once broke :443). So: the env
// override, then the macOS app bundle, then PATH for Linux / Homebrew installs.
const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
function cli(): string {
  if (process.env.MINAMI_TAILSCALE_BIN) return process.env.MINAMI_TAILSCALE_BIN;
  return fs.existsSync(APP_CLI) ? APP_CLI : "tailscale";
}

type ServeStatus = { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };

async function status(): Promise<ServeStatus> {
  const { stdout } = await exec(cli(), ["serve", "status", "--json"], { timeout: 8000 });
  return stdout.trim() ? JSON.parse(stdout) : {};
}

/** The https URL already serving this port's root, if any. Matches on the PROXY TARGET, not on the
 *  listening port — the dashboard itself is `:443 → 127.0.0.1:3000`, so a link to localhost:3000 must
 *  come back as the bare host, not as a second `:3000` entry. */
function find(s: ServeStatus, port: number): string | null {
  // `http://::1:<port>` is how serve REPORTS an IPv6 target (brackets stripped) — an entry someone
  // added by hand that way is still this port's, even though it cannot actually proxy (see below).
  const targets = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, `http://::1:${port}`]);
  for (const [hostPort, web] of Object.entries(s.Web || {})) {
    const proxy = web.Handlers?.["/"]?.Proxy?.replace(/\/+$/, "");
    if (proxy && targets.has(proxy)) return `https://${hostPort.replace(/:443$/, "")}`;
  }
  return null;
}

// Both families, IPv4 first. A Next dev server started with `-H localhost` (the ecvision pitch bench
// on :3120 is one) binds `[::1]` ONLY, so probing 127.0.0.1 alone reported "nothing is running" for a
// server that was up — and a serve entry proxying to 127.0.0.1 would have been a dead link anyway.
// So the probe also decides the proxy target: 127.0.0.1 if that answered, else the NAME `localhost`.
// Not `[::1]` — serve stores it unbracketed as `http://::1:<port>` and then answers every request with
// "unknown proxy destination"; the name resolves to both families and works.
const LOOPBACKS = ["127.0.0.1", "[::1]"];

async function answeringHost(port: number): Promise<string | null> {
  // Any HTTP answer counts, including a 404 or 500 — the question is "is a server there", and a
  // dev server mid-compile can take a while to say anything at all.
  for (const h of LOOPBACKS) {
    try { await fetch(`http://${h}:${port}/`, { signal: AbortSignal.timeout(4000), redirect: "manual" }); return h; }
    catch { /* try the other family */ }
  }
  return null;
}

export type ExposeResult = { ok: true; base: string; created: boolean } | { ok: false; status: number; error: string };

export async function exposePort(port: number): Promise<ExposeResult> {
  let s: ServeStatus;
  try { s = await status(); }
  catch (e) { return { ok: false, status: 503, error: `tailscale serve is not available here (${(e as Error).message.split("\n")[0]})` }; }
  const existing = find(s, port);
  if (existing) return { ok: true, base: existing, created: false };
  // Don't mint a serve entry for nothing: it would outlive this click and point the next visitor at
  // whatever happens to bind the port later.
  const host = await answeringHost(port);
  if (!host) return { ok: false, status: 404, error: `nothing is running on localhost:${port}` };
  try { await exec(cli(), ["serve", "--bg", `--https=${port}`, `http://${host === "[::1]" ? "localhost" : host}:${port}`], { timeout: 15000 }); }
  catch (e) { return { ok: false, status: 502, error: `tailscale serve failed: ${(e as Error).message.split("\n")[0]}` }; }
  const made = find(await status(), port);
  return made ? { ok: true, base: made, created: true } : { ok: false, status: 502, error: "tailscale serve reported success but lists no entry" };
}
