// Read-only view of the Blacksmith factory (~/dev/blacksmith), for the chat pane's operator panel and
// the bento tile badge.
//
// ── Why this reads HTTP and not the database ────────────────────────────────────────────────────────
// Blacksmith's source of truth is an append-only hash-chained event log (`state/events/*.jsonl`);
// `state/smith.db` is a DERIVED read-model that only exists because something ran the projector. Read
// the SQLite directly and you inherit two problems: it can be arbitrarily stale (nothing projects on a
// schedule — the daemon would, but `state/daemon/` has never existed on this box), and it runs in WAL
// mode, so a naive reader silently misses everything still in the 4MB write-ahead log.
//
// `smith ui serve` solves both by construction: it re-projects changed sessions on EVERY request
// (fingerprinting each log file by size+mtime), binds 127.0.0.1 only, and has no auth because it is
// local-first by design. So polling it is cheap, always current, and cannot write anything.
//
// ── The one thing this module exists to get right ───────────────────────────────────────────────────
// **Blacksmith has no `session-ended` event.** Its own UI says so: `runningSessions` reports
// `lastEventAt` as *evidence*, not as a fact, and leaves the judging to the caller. So there is no
// honest boolean for "is the factory running" and this module does not invent one. It reports the AGE
// of the last event and lets the panel say "quiet for 6m", which is both true and the thing the
// operator actually needs to decide whether to go look.
//
// The corollary bites harder, and it is the bug this whole panel is chasing: `liveAgentCount` counts
// `dispatch_decision` events that never got a terminal event. In a factory with no dispatch driver —
// every coder and reviewer hand-spawned, every `judge report` hand-typed — a forgotten report leaves a
// phantom "live agent" on the board FOREVER. A number that only ever goes up is worse than no number,
// so `staleAgents` separates the ones whose dispatch is older than any plausible turn.

import fsSync from "node:fs";
import os from "node:os";
import pathMod from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { BLACKSMITH_CLI, BLACKSMITH_HOME, BLACKSMITH_URL } from "@/lib/agent/manager";

/** A dispatched agent with no terminal event yet. `ageMs` is what decides whether that means
 *  "working" or "nobody ever closed this out". */
export type BlacksmithAgent = { id: string; role: string; provider: string; tier: string; taskId: string | null; epicId: string | null; dispatchedAt: string; ageMs: number };
export type BlacksmithSession = { sessionId: string; lastEventAt: string; lastEventType: string; eventCount: number; liveAgentCount: number; projects: string[]; quietMs: number };
export type BlacksmithTaskCount = { status: string; count: number };
export type BlacksmithTokens = { epicId: string; spent: number; budget: number | null };

export type BlacksmithState = {
  up: boolean;
  url: string;
  home: string;
  /** Why the factory could not be read — shown verbatim, because "is it down or is it just quiet?" is
   *  exactly the ambiguity this panel exists to remove. */
  reason?: string;
  lastEventAt: string | null;
  lastEventType: string | null;
  /** Age of the newest event anywhere in the factory. THE liveness signal — see the header. */
  quietMs: number | null;
  counts: { events: number; errors: number };
  lessonsPending: number;
  epicsInFlight: string[];
  sessions: BlacksmithSession[];
  agents: BlacksmithAgent[];
  /** Dispatched agents whose turn has run longer than any real one plausibly does — almost always a
   *  `judge report` the operator never typed, not work in progress. */
  staleAgents: BlacksmithAgent[];
  tasks: BlacksmithTaskCount[];
  /** Tasks carrying an open finding, worst-severity-first. `severity` is Blacksmith's own closed
   *  vocabulary (S1-stop-the-line … S4-nit), passed through rather than re-labelled. */
  findings: { severity: string; count: number }[];
  tokens: BlacksmithTokens[];
  alerts: { escalations: number; pendingWaivers: number };
  fetchedAt: number;
};

// A dispatch older than this is treated as abandoned bookkeeping rather than a running agent. Sized
// off the factory's own evidence: the longest MEASURED coder turn in the first external epic was ~247k
// tokens, well under an hour of wall-clock. Deliberately generous — the cost of calling a live agent
// stale is a wrong warning, and the cost of the opposite is the phantom that started this.
const STALE_AGENT_MS = 90 * 60 * 1000;

// `smith ui serve` re-projects the event log on every request, so each call does real work. Panes poll
// independently and the bento grid polls too; without this, six open panes would multiply that by six
// for data that cannot meaningfully change in between.
const CACHE_MS = 1500;
const FETCH_TIMEOUT_MS = 2500;

let cache: { at: number; value: BlacksmithState } | null = null;
let inflight: Promise<BlacksmithState> | null = null;

async function getJson<T>(path: string): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(BLACKSMITH_URL + path, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

const ageOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : null;
};

function down(reason: string): BlacksmithState {
  return {
    up: false, url: BLACKSMITH_URL, home: BLACKSMITH_HOME, reason,
    lastEventAt: null, lastEventType: null, quietMs: null,
    counts: { events: 0, errors: 0 }, lessonsPending: 0, epicsInFlight: [],
    sessions: [], agents: [], staleAgents: [], tasks: [], findings: [], tokens: [],
    alerts: { escalations: 0, pendingWaivers: 0 }, fetchedAt: Date.now(),
  };
}

async function load(): Promise<BlacksmithState> {
  // `/api/pulse` first and alone: it is the cheap column-projected probe (it never loads event
  // payloads), so a factory that isn't serving costs one failed connect rather than four.
  let pulse: { lastEventAt: string | null; lastEventType: string | null; counts?: { events: number; errors: number }; lessonsPending?: number };
  try {
    pulse = await getJson("/api/pulse");
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    // Distinguish the two failures that look identical in a log and mean opposite things to a human.
    return down(/abort/i.test(msg) ? `no response from ${BLACKSMITH_URL} within ${FETCH_TIMEOUT_MS}ms` : `not reachable at ${BLACKSMITH_URL} — start it with \`smith ui serve\``);
  }

  // The rest are best-effort and fetched together: a shape change in one of Blacksmith's endpoints
  // should degrade that section, not blank the panel that tells you the factory is alive.
  const [overview, kanban] = await Promise.all([
    getJson<any>("/api/overview").catch(() => null),
    getJson<any>("/api/kanban").catch(() => null),
  ]);

  const agents: BlacksmithAgent[] = (overview?.liveAgentEntries || []).map((a: any) => ({
    id: String(a.id),
    role: String(a.agentRole || "agent"),
    provider: String(a.provider || ""),
    tier: String(a.modelTier || ""),
    taskId: a.taskId ?? null,
    epicId: a.epicId ?? null,
    dispatchedAt: String(a.dispatchedAt || ""),
    ageMs: ageOf(a.dispatchedAt) ?? 0,
  }));

  const sessions: BlacksmithSession[] = (overview?.runningSessions || []).map((s: any) => ({
    sessionId: String(s.sessionId),
    lastEventAt: String(s.lastEventAt || ""),
    lastEventType: String(s.lastEventType || ""),
    eventCount: Number(s.eventCount || 0),
    liveAgentCount: Number(s.liveAgentCount || 0),
    projects: Array.isArray(s.projects) ? s.projects.map(String) : [],
    quietMs: ageOf(s.lastEventAt) ?? 0,
  })).sort((a: BlacksmithSession, b: BlacksmithSession) => a.quietMs - b.quietMs);

  // Kanban is an array of {taskStatus, tasks[]} columns. Two things come out of it: the status
  // histogram, and the open-findings histogram (each task carries `tags.severity` = its worst OPEN
  // finding, which is already the number an operator wants and saves a second endpoint).
  const tasks: BlacksmithTaskCount[] = [];
  const sevCount = new Map<string, number>();
  for (const col of Array.isArray(kanban) ? kanban : []) {
    const list = Array.isArray(col?.tasks) ? col.tasks : [];
    if (list.length) tasks.push({ status: String(col.taskStatus), count: list.length });
    for (const t of list) {
      const sev = t?.tags?.severity;
      if (sev) sevCount.set(String(sev), (sevCount.get(String(sev)) || 0) + 1);
    }
  }
  // S1 first — Blacksmith's severity ids sort correctly as strings ("S1-…" < "S2-…"), which is not an
  // accident of this code but of their naming, so sort explicitly rather than relying on it silently.
  const findings = [...sevCount.entries()].map(([severity, count]) => ({ severity, count })).sort((a, b) => a.severity.localeCompare(b.severity));

  return {
    up: true,
    url: BLACKSMITH_URL,
    home: BLACKSMITH_HOME,
    lastEventAt: pulse.lastEventAt ?? null,
    lastEventType: pulse.lastEventType ?? null,
    quietMs: ageOf(pulse.lastEventAt),
    counts: { events: Number(pulse.counts?.events || 0), errors: Number(pulse.counts?.errors || 0) },
    lessonsPending: Number(pulse.lessonsPending || 0),
    epicsInFlight: Array.isArray(overview?.epicsInFlight) ? overview.epicsInFlight.map(String) : [],
    sessions,
    agents,
    staleAgents: agents.filter((a) => a.ageMs > STALE_AGENT_MS),
    tasks,
    findings,
    tokens: (overview?.tokensByEpic || []).map((t: any) => ({ epicId: String(t.epicId), spent: Number(t.tokensSpent || 0), budget: t.tokensBudget == null ? null : Number(t.tokensBudget) })),
    alerts: { escalations: Number(overview?.alerts?.escalations || 0), pendingWaivers: Number(overview?.alerts?.pendingWaivers || 0) },
    fetchedAt: Date.now(),
  };
}

/** Current factory state, cached for CACHE_MS and de-duplicated across concurrent callers. Never
 *  throws: an unreachable factory is a legitimate answer (`up: false` plus a reason), not an error —
 *  most installs have no Blacksmith at all and the panel has to render that calmly. */
export async function blacksmithState(): Promise<BlacksmithState> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (inflight) return inflight;
  inflight = load()
    .catch((e) => down(String((e as Error)?.message || e)))
    .then((value) => { cache = { at: Date.now(), value }; inflight = null; return value; });
  return inflight;
}

// ── Starting the factory's own UI ────────────────────────────────────────────────────────────────────
// The one thing here that is not a read. It is still not a write to the FACTORY: `smith ui serve` is
// a read-only projector over the event log (see the header), and starting it changes nothing the
// gates care about. What it changes is whether the strip above every operator pane can answer its
// one question — and the strip used to say "start it with `smith ui serve`" to a person sitting in a
// browser with no terminal in reach. Spawned detached from the clone (its defaults — `state/smith.db`,
// `factory/specs/roadmap.md` — are relative to it), stdio to a log under tmpdir, unref'd so it outlives
// the request and the dashboard's own restarts. Refused when already up: two servers on one port is
// a crash on the second, and a crash log reads exactly like "won't start".
const UI_LOG = pathMod.join(os.tmpdir(), "minami-blacksmith-ui.log");
const UI_BOOT_MS = 8000;

export async function serveBlacksmithUi(): Promise<{ ok: boolean; up: boolean; url: string; reason?: string; log?: string }> {
  const url = BLACKSMITH_URL;
  const cur = await blacksmithState();
  if (cur.up) return { ok: true, up: true, url };
  if (!fsSync.existsSync(BLACKSMITH_CLI)) return { ok: false, up: false, url, reason: `no CLI at ${BLACKSMITH_CLI} — run \`pnpm build\` in the clone` };
  // The port is the URL's, so a box that moved the factory with MINAMI_BLACKSMITH_URL starts it where
  // the poller will look. Anything else in the URL (a remote host) is not something this can start.
  let port = 4680;
  try {
    const u = new URL(url);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname)) return { ok: false, up: false, url, reason: `${url} is not local — start it there` };
    if (u.port) port = Number(u.port);
  } catch { /* keep the default */ }
  let child: ChildProcess;
  try {
    const out = fsSync.openSync(UI_LOG, "a");
    child = spawn(process.execPath, [BLACKSMITH_CLI, "ui", "serve", "--port", String(port)], {
      cwd: BLACKSMITH_HOME, detached: true, stdio: ["ignore", out, out], env: { ...process.env },
    });
    child.unref();
    fsSync.closeSync(out);
  } catch (e) {
    return { ok: false, up: false, url, reason: `could not spawn: ${String((e as Error)?.message || e)}` };
  }
  // Wait for the pulse rather than for the process: a server that has started listening is the fact
  // the strip needs, and a process that exited is the fact the operator needs. `ui.not-built` (the
  // UI's own dist missing) exits in well under a second and lands in the log; surface its tail.
  const started = Date.now();
  let exited: number | null = null;
  child.on("exit", (code) => { exited = code ?? -1; });
  while (Date.now() - started < UI_BOOT_MS) {
    await new Promise((r) => setTimeout(r, 400));
    if (exited !== null) {
      const tail = readTail(UI_LOG, 600);
      const notBuilt = /ui\.not-built/.test(tail);
      return { ok: false, up: false, url, log: UI_LOG, reason: notBuilt ? "the factory UI isn't built — run `pnpm build:ui` in the clone, then retry" : `\`smith ui serve\` exited ${exited}${tail ? ` — ${tail.split("\n").filter(Boolean).slice(-1)[0]}` : ""}` };
    }
    cache = null; // the poller's cached "down" must not answer this probe
    const s = await blacksmithState();
    if (s.up) return { ok: true, up: true, url, log: UI_LOG };
  }
  return { ok: false, up: false, url, log: UI_LOG, reason: `started (pid ${child.pid}) but nothing answered at ${url} within ${UI_BOOT_MS / 1000}s — check the log` };
}

function readTail(file: string, bytes: number): string {
  try {
    const size = fsSync.statSync(file).size;
    const fd = fsSync.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(bytes, size));
    fsSync.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    fsSync.closeSync(fd);
    return buf.toString("utf8");
  } catch { return ""; }
}
