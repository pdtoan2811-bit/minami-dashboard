// The harness browser (§36): the ONE shared Chrome that tiktok-studio's scripts, the goal runners and agents drive
// over CDP on :9333, with its own profile (~/.harness/profiles/web) holding the logins they all ride on. Since
// 2026-10-27 it is the only logged-in browser on the Mac: the dashboard's chat browser starts from the cookies it
// exports to ~/.minami/browser/state.json (MINAMI_BROWSER_STATE), and "harness browser" is the one name for it. This module
// only reads it — status, open tabs, the usage log its daemon writes — and starts/stops the phone login page
// through the studio's own CLI. It never launches Chrome itself: two launchers on one profile corrupt it.
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { phoneAccess } from "@/lib/tailnet";

const exec = promisify(execFile);
export const HARNESS_DIR = process.env.MINAMI_HARNESS_DIR || path.join(os.homedir(), ".harness");
const STUDIO = process.env.MINAMI_HARNESS_STUDIO || path.join(os.homedir(), "tiktok-studio");
const CDP = Number(process.env.HARNESS_BROWSER_PORT || 9333);
const LOGIN_PORT = 5592; // fixed in the studio's scripts/browser.mjs

export type UsageEvent = { at: string; ev: "up" | "down" | "open" | "nav" | "title" | "close" | "login" | "login-off"; tab?: number; url?: string; title?: string };
export type Visit = { id: string; start: string; end: string | null; open: boolean; steps: { at: string; url: string; title?: string }[] };
export type HarnessState = {
  up: boolean; browser: string | null;
  tabs: { url: string; title: string }[];
  login: { up: boolean; url: string | null };
  visits: Visit[];
  /** Browser up/down and login opened/closed, newest first. */
  marks: { at: string; ev: string; url?: string }[];
  daemonLog: string[]; loginLog: string[];
  /** Signed in or not per site, from the exported cookie file (names only — values are never read out). */
  logins: { site: string; on: boolean }[]; loginsAt: string | null;
  /** The daemon only started writing usage.jsonl on 2026-10-27; before that there's just browser.log. */
  logStarted: string | null;
};

const strip = (u: string) => { try { const x = new URL(u); return x.protocol.startsWith("http") ? x.origin + x.pathname : null; } catch { return null; } };

/** The last `bytes` of a file as lines — the logs only grow, and only the recent end is ever shown. */
function tail(file: string, bytes = 400_000): string[] {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes), buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n").filter(Boolean);
      return start > 0 ? lines.slice(1) : lines; // the first line of a mid-file read is cut
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

const listening = (port: number) => new Promise<boolean>((r) => {
  const s = net.connect(port, "127.0.0.1", () => { s.end(); r(true); });
  s.on("error", () => r(false));
  s.setTimeout(800, () => { s.destroy(); r(false); });
});

async function cdp<T>(p: string): Promise<T | null> {
  try { return (await (await fetch(`http://127.0.0.1:${CDP}${p}`, { signal: AbortSignal.timeout(1500) })).json()) as T; } catch { return null; }
}

/** Tab ids restart at 1 every time the daemon starts, so a visit is keyed by (daemon run, tab). */
function visitsOf(events: UsageEvent[]): Visit[] {
  const out = new Map<string, Visit>();
  let run = 0;
  for (const e of events) {
    if (e.ev === "up") { run++; for (const v of out.values()) if (v.open) { v.open = false; v.end ??= e.at; } continue; }
    if (e.ev === "down") { for (const v of out.values()) if (v.open) { v.open = false; v.end = e.at; } continue; }
    if (e.tab == null || !e.url) continue;
    const id = `${run}:${e.tab}`;
    let v = out.get(id);
    if (!v) { v = { id, start: e.at, end: null, open: true, steps: [] }; out.set(id, v); }
    if (e.ev === "open" || e.ev === "nav") v.steps.push({ at: e.at, url: e.url });
    else if (e.ev === "title") { const s = [...v.steps].reverse().find((x) => x.url === e.url); if (s) s.title = e.title; }
    else if (e.ev === "close") { v.open = false; v.end = e.at; }
  }
  return [...out.values()].filter((v) => v.steps.length).sort((a, b) => b.start.localeCompare(a.start));
}

// Same table as tiktok-studio's scripts/lib/logins.mjs: the cookie that means "signed in" on each site.
const SITES: [string, string[], string[]][] = [
  ["Google / YouTube", ["google.com", "youtube.com"], ["SAPISID", "__Secure-3PAPISID", "LOGIN_INFO"]],
  ["TikTok", ["tiktok.com"], ["sessionid", "sid_tt"]], ["Instagram", ["instagram.com"], ["sessionid"]],
  ["X", ["x.com", "twitter.com"], ["auth_token"]], ["Facebook", ["facebook.com"], ["c_user"]],
  ["LinkedIn", ["linkedin.com"], ["li_at"]], ["Pinterest", ["pinterest.com"], ["_pinterest_sess"]], ["Reddit", ["reddit.com"], ["reddit_session", "token_v2"]],
];
const STATE = process.env.MINAMI_BROWSER_STATE || path.join(os.homedir(), ".minami", "browser", "state.json");
function logins(): { list: { site: string; on: boolean }[]; at: string | null } {
  try {
    const { cookies } = JSON.parse(fs.readFileSync(STATE, "utf8")) as { cookies: { name: string; domain: string }[] };
    const on = (d: string[], names: string[]) => cookies.some((c) => names.includes(c.name) && d.some((x) => c.domain.replace(/^\./, "") === x || c.domain.endsWith("." + x)));
    return { list: SITES.map(([site, d, names]) => ({ site, on: on(d, names) })), at: fs.statSync(STATE).mtime.toISOString() };
  } catch { return { list: [], at: null }; }
}

export async function harnessState(): Promise<HarnessState> {
  const events = tail(path.join(HARNESS_DIR, "usage.jsonl")).map((l) => { try { return JSON.parse(l) as UsageEvent; } catch { return null; } }).filter((e): e is UsageEvent => !!e);
  const [ver, list, loginUp] = await Promise.all([
    cdp<{ Browser?: string }>("/json/version"),
    cdp<{ type: string; url: string; title: string }[]>("/json/list"),
    listening(LOGIN_PORT),
  ]);
  let loginUrl: string | null = null;
  if (loginUp) {
    const host = (await phoneAccess().catch(() => null))?.url?.match(/^https:\/\/([^/:]+)/)?.[1];
    loginUrl = host ? `https://${host}:${LOGIN_PORT}/` : `http://127.0.0.1:${LOGIN_PORT}/`;
  }
  return {
    up: !!ver, browser: ver?.Browser ?? null,
    tabs: (list || []).filter((t) => t.type === "page").map((t) => ({ url: strip(t.url) || t.url, title: t.title })).filter((t) => t.url !== "about:blank"),
    login: { up: loginUp, url: loginUrl },
    visits: visitsOf(events).slice(0, 300),
    marks: events.filter((e) => ["up", "down", "login", "login-off"].includes(e.ev)).slice(-60).reverse().map((e) => ({ at: e.at, ev: e.ev, ...(e.url ? { url: e.url } : {}) })),
    daemonLog: tail(path.join(HARNESS_DIR, "browser.log"), 20_000).slice(-40),
    loginLog: tail(path.join(HARNESS_DIR, "login.log"), 20_000).slice(-40),
    ...(({ list, at }) => ({ logins: list, loginsAt: at }))(logins()),
    logStarted: events[0]?.at ?? null,
  };
}

/** Run the studio's harness browser CLI — the one place that knows how to start, show, hide and export it. */
async function cli(...rest: string[]): Promise<{ ok: boolean; out: string }> {
  const args = [path.join(STUDIO, "scripts", "browser.mjs"), ...rest];
  try {
    const { stdout, stderr } = await exec(process.execPath, args, { cwd: STUDIO, timeout: 60_000 });
    return { ok: true, out: (stdout + stderr).trim().slice(-600) };
  } catch (e) {
    return { ok: false, out: String((e as { stderr?: string }).stderr || (e as Error).message).trim().slice(-600) };
  }
}

/** Login: the window on this Mac's screen AND the phone page. Off: close the page, park the window, export cookies. */
export const harnessLogin = (on: boolean, url?: string) => cli("login", ...(on ? (url ? [url] : []) : ["off"]));
/** Just the window: on this Mac's screen, or parked off-screen (which also exports the cookies). */
export const harnessWindow = (show: boolean) => cli(show ? "show" : "hide");
