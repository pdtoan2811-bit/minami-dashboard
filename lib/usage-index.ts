// Usage index — what this machine spent on Claude, read from the transcripts themselves (§16).
//
// Why this exists: the Metrics board's usage cards read a collector on the Hetzner box (server/
// metrics-server.js, fed by a Stop hook). The box was retired on 2026-10-14 and every card went quietly
// stale. The transcripts under ~/.claude/projects are the one record every Claude process on this Mac
// writes — dashboard panes, the terminal, the desktop app, the Minami bot — so they replace the
// collector rather than repairing it: nothing to run, nothing to ingest, nothing to fall over.
//
// Cost model: incremental. Each file keeps a byte offset; a refresh reads only what was appended since,
// and only lines carrying `"usage"` are parsed (the prefilter is what makes the first build ~1 minute
// instead of several over ~4 GB). State persists to ~/.minami/usage-index.json so a deploy does not
// re-read the world. Buckets are hourly and pruned past KEEP_DAYS.
//
// Dollars are LIST prices — a yardstick, not a bill (the box is on a subscription). The subscription
// limit tracks token cost closely enough that shares and trends read true; `limits` samples the real
// 5-hour / 7-day bars alongside so the two can be calibrated against each other.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tokStatus } from "./token-slayer";

const ROOT = path.join(os.homedir(), ".claude", "projects");
const STATE = path.join(os.homedir(), ".minami", "usage-index.json");
const SAMPLES = path.join(os.homedir(), ".minami", "limit-samples.jsonl");
// Headless runs that keep no transcript (`claude -p --no-session-persistence`: the toolshed's claude.mjs, the
// nightly video builders, pitch, today-research) log what the CLI reported they used here instead (2026-10-21).
// Before it existed they were invisible — the overnight run alone was ~70 Opus sessions a night.
const LEDGER = process.env.MINAMI_HEADLESS_USAGE || path.join(os.homedir(), ".minami", "headless-usage.jsonl");
const KEEP_DAYS = 35;
const VERSION = 7;
const REFRESH_MS = 60_000;
const SAMPLE_MS = 10 * 60_000;

// $/MTok — input, output, cache read, 5-min cache write. platform.claude.com pricing, checked 2026-10-21.
// Haiku 5.5 is priced at its ≤100k-prompt tier and 5× above it.
function priceOf(model: string, ctx: number): [number, number, number, number] {
  if (/fable/.test(model)) return [10, 50, model.includes("5-1") ? 0.25 : 1, 12.5];
  if (/opus-5-5/.test(model)) return [4, 20, 0.2, 5];
  if (/opus/.test(model)) return [5, 25, 0.5, 6.25];
  if (/sonnet-5-5/.test(model)) return [2, 10, 0.1, 2.5];
  if (/sonnet-5/.test(model)) return [2, 10, 0.2, 2.5];
  if (/sonnet/.test(model)) return [3, 15, 0.3, 3.75];
  if (/haiku-5-5/.test(model)) { const k = ctx > 100_000 ? 5 : 1; return [0.1 * k, 0.5 * k, 0.01 * k, 0.125 * k]; }
  if (/haiku/.test(model)) return [1, 5, 0.1, 1.25];
  return [4, 20, 0.2, 5];
}

export type Family = "opus" | "sonnet" | "haiku" | "fable" | "other";
export const familyOf = (m: string): Family => (m.match(/opus|sonnet|haiku|fable/)?.[0] as Family) || "other";
const bandOf = (ctx: number) => (ctx < 100e3 ? 0 : ctx < 200e3 ? 1 : ctx < 400e3 ? 2 : 3);

type Agg = { calls: number; tin: number; tout: number; cr: number; cw: number; usd: number };
type FileState = { size: number; offset: number; proj: string; sub: boolean; sid: string; runModel?: string };
type SessionRow = { sid: string; proj: string; title: string; usd: number; subUsd: number; calls: number; peak: number; last: number; first: number; fam: Partial<Record<Family, number>> };
type SubRun = { day: string; fam: Family; type: string };
type AutoRow = { day: string; source: string; fam: Family; runs: number; usd: number; ms: number };
type State = { v: number; files: Record<string, FileState>; buckets: Record<string, Agg>; sessions: Record<string, SessionRow>; runs: SubRun[]; seen: Record<string, number>; auto: Record<string, AutoRow>; ledgerOffset: number; builtAt: number };

let state: State | null = null;
let refreshing: Promise<void> | null = null;
let lastRefresh = 0;
let lastSample = 0;
let progress = { done: 0, total: 0 };

function load(): State {
  if (state) return state;
  try {
    const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
    if (s.v === VERSION) return (state = s);
  } catch { /* first run, or an older format — rebuild */ }
  return (state = { v: VERSION, files: {}, buckets: {}, sessions: {}, runs: [], seen: {}, auto: {}, ledgerOffset: 0, builtAt: 0 });
}

// Project label from the transcript folder: "-Users-me-tiktok-studio--minami-worktrees-chat-3" →
// "tiktok-studio". Worktrees fold into their repo, because "which project" is the question, not "which pane".
function projectOf(dir: string): string {
  const home = os.homedir().replace(/[^A-Za-z0-9]/g, "-");
  let p = dir.startsWith(home) ? dir.slice(home.length) : dir;
  p = p.replace(/^-+/, "").replace(/--?(minami|claude)-worktrees-.*$/, "").replace(/^\.?-?/, "");
  return p || "~ (home)";
}

function walk(dir: string, since: number, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, since, out);
    else if (e.name.endsWith(".jsonl")) { try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch { /* vanished */ } }
  }
  return out;
}

const hourOf = (ts: number) => Math.floor(ts / 3_600_000);

async function readAppended(file: string, st: FileState, S: State, cutoff: number): Promise<void> {
  const size = fs.statSync(file).size;
  if (size < st.offset) { st.offset = 0; } // truncated / rewritten
  if (size === st.offset) return;
  const fd = fs.openSync(file, "r");
  try {
    const CHUNK = 4 << 20;
    let pos = st.offset, carry = "";
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, pos);
      pos += len;
      const text = carry + buf.toString("utf8");
      const lines = text.split("\n");
      carry = lines.pop() ?? ""; // incomplete tail — re-read next time
      for (const line of lines) handleLine(line, st, S, cutoff);
      // yield so a request in flight is not starved during the first build
      await new Promise((r) => setImmediate(r));
    }
    st.offset = size - Buffer.byteLength(carry, "utf8");
    st.size = size;
  } finally { fs.closeSync(fd); }
}

function handleLine(line: string, st: FileState, S: State, cutoff: number) {
  const isUsage = line.includes('"usage"') && line.includes('"assistant"');
  const sess = S.sessions[st.sid];
  const wantsTitle = !st.sub && (!sess || !sess.title) && line.includes('"type":"user"');
  if (!isUsage && !wantsTitle) return;
  let j: any; try { j = JSON.parse(line); } catch { return; }
  if (wantsTitle && j.type === "user" && !j.isMeta && typeof j.message?.content === "string") {
    const t = j.message.content.replace(/\s+/g, " ").trim();
    if (t && !t.startsWith("<")) {
      const row = S.sessions[st.sid] ??= newSession(st);
      if (!row.title) row.title = t.slice(0, 140);
    }
    return;
  }
  const m = j.message;
  if (j.type !== "assistant" || !m?.usage || !m.model || m.model === "<synthetic>") return;
  const ts = Date.parse(j.timestamp);
  if (!(ts >= cutoff)) return;
  // Count each API response once, box-wide. Two ways it repeats: one line per content block, each
  // carrying the same usage, and not always adjacent (measured 2026-10-21: consecutive-only dedupe
  // counted a 1,457-response transcript as 3,102); and a resumed or forked chat copies its history into
  // a NEW transcript with the same ids, so per-file dedupe still over-counted main threads by ~20%.
  // Keyed on the id's tail (unique enough, ~3 MB for the window) and pruned by hour with the buckets.
  const key = `${(m.id || "").slice(-14)}${(j.requestId || "").slice(-6)}`;
  if (key) { if (S.seen[key] !== undefined) return; S.seen[key] = hourOf(ts); }
  const u = m.usage;
  const tin = u.input_tokens || 0, tout = u.output_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
  const ctx = tin + cr + cw;
  const p = priceOf(m.model, ctx);
  const usd = (tin * p[0] + tout * p[1] + cr * p[2] + cw * p[3]) / 1e6;
  const fam = familyOf(m.model);
  // Where it ran is the app (a subagent line carries its parent's entrypoint); main-vs-subagent is the
  // separate `sub` dimension. Mixing them made "Subagents" look like a fourth app beside the dashboard.
  const entry = String(j.entrypoint || "unknown");
  const bk = `${hourOf(ts)}|${fam}|${st.sub ? 1 : 0}|${entry}|${st.proj}|${bandOf(ctx)}`;
  const b = S.buckets[bk] ??= { calls: 0, tin: 0, tout: 0, cr: 0, cw: 0, usd: 0 };
  b.calls++; b.tin += tin; b.tout += tout; b.cr += cr; b.cw += cw; b.usd += usd;
  if (st.sub && !st.runModel) {
    st.runModel = fam;
    S.runs.push({ day: dayKey(ts), fam, type: st.proj });
  }
  const row = S.sessions[st.sid] ??= newSession(st);
  row.usd += usd; row.calls++; if (st.sub) row.subUsd += usd;
  row.peak = Math.max(row.peak, ctx); row.last = Math.max(row.last, ts); row.first = row.first ? Math.min(row.first, ts) : ts;
  row.fam[fam] = (row.fam[fam] || 0) + usd;
}

const newSession = (st: FileState): SessionRow => ({ sid: st.sid, proj: st.proj, title: "", usd: 0, subUsd: 0, calls: 0, peak: 0, last: 0, first: 0, fam: {} });

// Local calendar day — the board is read by a person in this timezone, not by UTC.
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "/Users/me/tiktok-studio/.minami-worktrees/x/scripts" → "tiktok-studio"; anything outside $HOME (a temp dir) → "~ (home)".
function projectOfCwd(cwd?: string): string {
  const home = os.homedir();
  if (!cwd || !cwd.startsWith(home + path.sep)) return "~ (home)";
  return cwd.slice(home.length + 1).split(path.sep)[0] || "~ (home)";
}

function readLedger(S: State, cutoff: number) {
  let size = 0;
  try { size = fs.statSync(LEDGER).size; } catch { return; }
  if (size < S.ledgerOffset) S.ledgerOffset = 0;
  if (size === S.ledgerOffset) return;
  const fd = fs.openSync(LEDGER, "r");
  try {
    const buf = Buffer.alloc(size - S.ledgerOffset);
    fs.readSync(fd, buf, 0, buf.length, S.ledgerOffset);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return;
    for (const line of text.slice(0, end).split("\n")) {
      let r: any; try { r = JSON.parse(line); } catch { continue; }
      if (!(r.ts >= cutoff)) continue;
      const proj = projectOfCwd(r.cwd);
      const source = String(r.source || "unknown");
      // A run reports every model it touched — the CLI's own small helper calls show up as a second Haiku entry —
      // so the run is counted once, on the model that cost the most.
      let topFam: Family | null = null, topUsd = -1;
      for (const [model, u] of Object.entries<any>(r.modelUsage || {})) {
        const tin = u.inputTokens || 0, tout = u.outputTokens || 0, cr = u.cacheReadInputTokens || 0, cw = u.cacheCreationInputTokens || 0;
        // The result reports a whole run, not each call — the per-call context is its average over the run's turns.
        const turns = Math.max(1, Number(r.turns) || 1);
        const ctx = (tin + cr + cw) / turns;
        const p = priceOf(model, ctx);
        const usd = (tin * p[0] + tout * p[1] + cr * p[2] + cw * p[3]) / 1e6;
        const fam = familyOf(model);
        const bk = `${hourOf(r.ts)}|${fam}|0|headless|${proj}|${bandOf(ctx)}`;
        const b = S.buckets[bk] ??= { calls: 0, tin: 0, tout: 0, cr: 0, cw: 0, usd: 0 };
        b.calls += turns; b.tin += tin; b.tout += tout; b.cr += cr; b.cw += cw; b.usd += usd;
        const ak = `${dayKey(r.ts)}|${source}|${fam}`;
        const a = S.auto[ak] ??= { day: dayKey(r.ts), source, fam, runs: 0, usd: 0, ms: 0 };
        a.usd += usd;
        if (usd > topUsd) { topUsd = usd; topFam = fam; }
      }
      if (topFam) { const a = S.auto[`${dayKey(r.ts)}|${source}|${topFam}`]; a.runs++; a.ms += Number(r.ms) || 0; }
    }
    S.ledgerOffset += Buffer.byteLength(text.slice(0, end + 1), "utf8");
  } finally { fs.closeSync(fd); }
}

async function refresh(): Promise<void> {
  const S = load();
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const files = walk(ROOT, cutoff);
  progress = { done: 0, total: files.length };
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const parts = rel.split(path.sep);
    const sub = parts.includes("subagents");
    const sid = sub ? parts[1] : path.basename(f, ".jsonl");
    const st = S.files[f] ??= { size: 0, offset: 0, proj: projectOf(parts[0]), sub, sid };
    try { await readAppended(f, st, S, cutoff); } catch { /* unreadable mid-write — next refresh */ }
    progress.done++;
  }
  try { readLedger(S, cutoff); } catch { /* a malformed ledger must not stop the transcript index */ }
  // Prune: files that aged out, buckets and sessions past the window.
  const minHour = hourOf(cutoff);
  for (const k of Object.keys(S.buckets)) if (Number(k.slice(0, k.indexOf("|"))) < minHour) delete S.buckets[k];
  for (const [k, h] of Object.entries(S.seen)) if (h < minHour) delete S.seen[k];
  for (const [k, s] of Object.entries(S.sessions)) if (s.last && s.last < cutoff) delete S.sessions[k];
  for (const k of Object.keys(S.files)) if (!files.includes(k)) delete S.files[k];
  const minDay = dayKey(cutoff); S.runs = S.runs.filter((r) => r.day >= minDay);
  for (const [k, a] of Object.entries(S.auto)) if (a.day < minDay) delete S.auto[k];
  S.builtAt = Date.now();
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE + ".tmp", JSON.stringify(S));
    fs.renameSync(STATE + ".tmp", STATE);
  } catch { /* disk full / read-only — the in-memory index still serves */ }
}

// The real limit bars, sampled so the board can draw how the week was spent against the cap. `tok status`
// is a subprocess (~1s), hence the 10-minute floor.
export type LimitSample = { ts: number; email?: string; five?: number; seven?: number; fiveReset?: number; sevenReset?: number };
async function sampleLimits(): Promise<void> {
  if (Date.now() - lastSample < SAMPLE_MS) return;
  lastSample = Date.now();
  try {
    const st = await tokStatus();
    const a = st?.accounts.find((x) => x.active) || st?.accounts.find((x) => x.email === st?.active);
    if (!a?.usage) return;
    const ms = (v?: number) => (v ? (v < 1e12 ? v * 1000 : v) : undefined);
    const s: LimitSample = { ts: Date.now(), email: a.email, five: a.usage.five_hour?.utilization, seven: a.usage.seven_day?.utilization,
      fiveReset: ms(a.usage.five_hour?.resets_at), sevenReset: ms(a.usage.seven_day?.resets_at) };
    fs.appendFileSync(SAMPLES, JSON.stringify(s) + "\n");
  } catch { /* tok missing or slow — the board shows the gauges as unknown */ }
}

function readSamples(since: number): LimitSample[] {
  try {
    return fs.readFileSync(SAMPLES, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((s: LimitSample) => s.ts >= since);
  } catch { return []; }
}

/** Kick a refresh if the last one is older than REFRESH_MS. Never awaits a full build on the request path. */
export function ensureFresh(): { building: boolean; progress: typeof progress } {
  const S = load();
  if (!refreshing && Date.now() - lastRefresh > REFRESH_MS) {
    lastRefresh = Date.now();
    refreshing = Promise.all([refresh(), sampleLimits()]).then(() => undefined).finally(() => { refreshing = null; });
  }
  return { building: !!refreshing && !S.builtAt, progress };
}

export async function waitFresh(timeoutMs: number): Promise<void> {
  ensureFresh();
  if (refreshing) await Promise.race([refreshing, new Promise((r) => setTimeout(r, timeoutMs))]);
}

// ---- the board's view --------------------------------------------------------------------------------

export const ENTRY_LABEL: Record<string, string> = {
  "sdk-ts": "Dashboard chats", "sdk-cli": "Minami bot & scripts", headless: "Automations (logged runs)", cli: "Terminal", "claude-desktop": "Desktop app",
  unknown: "Other",
};

export type UsageView = {
  builtAt: number; building: boolean; progress: { done: number; total: number }; days: number;
  total: Agg; prevTotal: Agg;
  daily: { day: string; fam: Record<Family, number>; main: number; sub: number; band: number[] }[];
  heat: number[][]; // [weekday 0=Mon][hour] usd
  entries: { key: string; label: string; usd: number; calls: number }[];
  projects: { name: string; usd: number; calls: number; sub: number }[];
  famTotals: Record<Family, number>;
  bandTotals: number[];
  subRuns: { day: string; fam: Record<Family, number> }[];
  sessions: (SessionRow & { href: string })[];
  limits: LimitSample[];
  automations: { source: string; usd: number; runs: number; hours: number; fam: Partial<Record<Family, number>> }[];
  ledgerSince: number | null;
};

function autoView(S: State, fromDay: string): UsageView["automations"] {
  const m = new Map<string, UsageView["automations"][number]>();
  for (const a of Object.values(S.auto)) {
    if (a.day < fromDay) continue;
    // "overnight:build" and "overnight:research" read as one job with stages; keep the stage visible.
    const r = m.get(a.source) || { source: a.source, usd: 0, runs: 0, hours: 0, fam: {} };
    r.usd += a.usd; r.runs += a.runs; r.hours += a.ms / 3_600_000; r.fam[a.fam] = (r.fam[a.fam] || 0) + a.usd;
    m.set(a.source, r);
  }
  return [...m.values()].sort((a, b) => b.usd - a.usd);
}

function ledgerStart(): number | null {
  try {
    const fd = fs.openSync(LEDGER, "r");
    try { const b = Buffer.alloc(8192); const n = fs.readSync(fd, b, 0, 8192, 0); return JSON.parse(b.subarray(0, n).toString("utf8").split("\n")[0]).ts ?? null; }
    finally { fs.closeSync(fd); }
  } catch { return null; }
}

export function view(days: number): UsageView {
  const S = load();
  const { building } = ensureFresh();
  const now = Date.now();
  const from = now - days * 864e5, prevFrom = from - days * 864e5;
  const fromH = hourOf(from), prevH = hourOf(prevFrom);
  const zero = (): Agg => ({ calls: 0, tin: 0, tout: 0, cr: 0, cw: 0, usd: 0 });
  const total = zero(), prevTotal = zero();
  const fams: Family[] = ["opus", "sonnet", "haiku", "fable", "other"];
  const famZero = () => Object.fromEntries(fams.map((f) => [f, 0])) as Record<Family, number>;
  const dayMap = new Map<string, UsageView["daily"][number]>();
  for (let t = from; t <= now + 1; t += 864e5) { const d = dayKey(t); dayMap.set(d, { day: d, fam: famZero(), main: 0, sub: 0, band: [0, 0, 0, 0] }); }
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const entries = new Map<string, { usd: number; calls: number }>();
  const projects = new Map<string, { usd: number; calls: number; sub: number }>();
  const famTotals = famZero(); const bandTotals = [0, 0, 0, 0];
  const addAgg = (a: Agg, b: Agg) => { a.calls += b.calls; a.tin += b.tin; a.tout += b.tout; a.cr += b.cr; a.cw += b.cw; a.usd += b.usd; };
  for (const [k, b] of Object.entries(S.buckets)) {
    const [hs, fam, sub, entry, proj, band] = k.split("|");
    const h = Number(hs);
    if (h < prevH) continue;
    if (h < fromH) { addAgg(prevTotal, b); continue; }
    addAgg(total, b);
    const ts = h * 3_600_000; const d = new Date(ts);
    const row = dayMap.get(dayKey(ts));
    if (row) { row.fam[fam as Family] += b.usd; if (sub === "1") row.sub += b.usd; else row.main += b.usd; row.band[Number(band)] += b.usd; }
    heat[(d.getDay() + 6) % 7][d.getHours()] += b.usd;
    const e = entries.get(entry) || { usd: 0, calls: 0 }; e.usd += b.usd; e.calls += b.calls; entries.set(entry, e);
    const p = projects.get(proj) || { usd: 0, calls: 0, sub: 0 }; p.usd += b.usd; p.calls += b.calls; if (sub === "1") p.sub += b.usd; projects.set(proj, p);
    famTotals[fam as Family] += b.usd; bandTotals[Number(band)] += b.usd;
  }
  const runMap = new Map<string, Record<Family, number>>();
  for (const d of dayMap.keys()) runMap.set(d, famZero());
  for (const r of S.runs) { const m = runMap.get(r.day); if (m) m[r.fam]++; }
  const sessions = Object.values(S.sessions).filter((s) => s.last >= from).sort((a, b) => b.usd - a.usd).slice(0, 12)
    .map((s) => ({ ...s, href: `/?open=${s.sid}` }));
  return {
    builtAt: S.builtAt, building, progress, days, total, prevTotal,
    daily: [...dayMap.values()], heat,
    entries: [...entries].map(([key, v]) => ({ key, label: ENTRY_LABEL[key] || key, ...v })).sort((a, b) => b.usd - a.usd),
    projects: [...projects].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.usd - a.usd).slice(0, 10),
    famTotals, bandTotals,
    subRuns: [...runMap].map(([day, fam]) => ({ day, fam })),
    sessions,
    limits: readSamples(now - Math.max(days, 7) * 864e5),
    automations: autoView(S, dayKey(from)),
    ledgerSince: ledgerStart(),
  };
}
