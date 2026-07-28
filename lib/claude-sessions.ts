/* eslint-disable @typescript-eslint/no-explicit-any */
// Server-only: read Claude Code session transcripts (~/.claude/projects/<enc-cwd>/<id>.jsonl) and
// summarize them for the Bento mirror. Zero deps — Phase 1 observes real terminal/CLI sessions
// read-only. (Driving sessions = Phase 2 via @anthropic-ai/claude-agent-sdk.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENRICH_MARKER, getEnrichment } from "./bento-enrich";
import { eventCost } from "./routing"; // single source of truth for model prices
import { summarizeToolResult, type ToolOutput } from "./agent/labels";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

// Read only the last `maxBytes` of a file (dropping the partial leading line), so opening a huge
// transcript doesn't mean reading/parsing megabytes we'll throw away — we only render the last turns.
const TAIL_BYTES = 1_500_000;
function readTail(file: string, size: number, maxBytes = TAIL_BYTES): string {
  if (size <= maxBytes) return fs.readFileSync(file, "utf8");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    const s = buf.toString("utf8", 0, read);
    const nl = s.indexOf("\n"); // the first line is probably truncated — drop it
    return nl >= 0 ? s.slice(nl + 1) : s;
  } finally { fs.closeSync(fd); }
}

// Turn a raw first-prompt into a meaningful title — strip known preambles (Minami's persona prompt,
// the compaction prompt, local-command dumps) and surface the actual topic.
function cleanTitle(raw: string): string {
  if (!raw) return "";
  const s = raw.trim();
  const m = s.match(/Message:\s*"([^"]{2,140})"/); // Minami's brain prompt embeds the real Slack message here
  if (m) return m[1].trim();
  if (/^You are compacting/i.test(s)) return "Compacting memory";
  if (/^You are Minami/i.test(s)) return "Minami · Slack turn";
  if (/^<local-command/i.test(s) || /^<command-name/i.test(s) || /^Caveat: The messages/i.test(s)) return "";
  return s.slice(0, 80);
}

export function tierOf(model?: string): string {
  if (!model) return "Opus";
  if (model.includes("haiku")) return "Haiku";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("fable")) return "Fable";
  return "Opus";
}

export type SessionMeta = {
  id: string;
  project: string;
  cwd: string;
  gitBranch: string;
  title: string;
  lastPrompt: string;
  model: string;
  tier: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  messages: number;
  tools: number;
  toolNames: string[];
  lastActivity: number;
  active: boolean;
  task?: string;   // specific task (Project > Goal > Task)
  goal?: string;   // mid-level objective within the project, for grouping
  lastRole: string; // "user" | "assistant" — who spoke last (a cheap review signal)
  tail: string;      // short snippet of the last message (for the semantic review check)
  review?: boolean;  // LLM-decided: does this session need the user's attention?
};

type Row = { type?: string; message?: any; cwd?: string; gitBranch?: string; timestamp?: string; customTitle?: string; lastPrompt?: string };

// Metadata cache, keyed by file + mtime. Kept on globalThis so a Next dev hot-reload doesn't wipe it,
// and mirrored to disk so a fresh server launch doesn't have to re-read+parse every (often huge) JSONL
// just to build the grid — that cold read was ~9s and blocked the whole UI from rendering.
const cache: Map<string, { mtime: number; meta: SessionMeta }> = ((globalThis as any).__minamiMetaCache ||= new Map());
const CACHE_DIR = path.join(os.homedir(), ".minami-bento");
const META_CACHE_FILE = path.join(CACHE_DIR, "meta-cache.json");
let cacheDirty = false;
function loadDiskCache(): void {
  const g = globalThis as any;
  if (g.__minamiMetaCacheLoaded) return;
  g.__minamiMetaCacheLoaded = true;
  try {
    const obj = JSON.parse(fs.readFileSync(META_CACHE_FILE, "utf8")) as Record<string, { mtime: number; meta: SessionMeta }>;
    for (const [f, v] of Object.entries(obj)) if (!cache.has(f)) cache.set(f, v);
  } catch { /* no cache file yet — first run */ }
}
function saveDiskCache(): void {
  if (!cacheDirty) return;
  cacheDirty = false;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const obj: Record<string, { mtime: number; meta: SessionMeta }> = {};
    for (const [f, v] of cache) obj[f] = v;
    fs.writeFileSync(META_CACHE_FILE, JSON.stringify(obj));
  } catch { /* best effort */ }
}

function summarize(file: string, id: string, raw?: string): SessionMeta {
  // Serve an unchanged file from cache — transcripts are polled every couple seconds and reparsing a
  // multi-MB JSONL each time is the main source of lag. `active` is time-derived, so recompute it.
  const mtime = fs.statSync(file).mtimeMs;
  const cached = cache.get(file);
  if (cached && cached.mtime === mtime) return { ...cached.meta, active: Date.now() - cached.meta.lastActivity < 120000 };
  let title = "", lastPrompt = "", model = "", cwd = "", gitBranch = "", firstUser = "", lastText = "", lastRole = "";
  let tin = 0, tout = 0, cost = 0, messages = 0, tools = 0, lastTs = 0;
  const toolSet = new Set<string>();
  const data = raw ?? fs.readFileSync(file, "utf8");
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    let r: Row;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.cwd) cwd = r.cwd;
    if (r.gitBranch) gitBranch = r.gitBranch;
    if (r.timestamp) { const ms = Date.parse(r.timestamp); if (ms > lastTs) lastTs = ms; }
    if (r.type === "custom-title" && r.customTitle) title = r.customTitle;
    else if (r.type === "last-prompt" && r.lastPrompt) lastPrompt = r.lastPrompt;
    else if (r.type === "user") {
      messages++;
      const c = r.message?.content;
      let txt = "";
      if (typeof c === "string") txt = c;
      else if (Array.isArray(c)) txt = c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ");
      if (txt.trim() && !firstUser) firstUser = txt.trim();
      if (txt.trim()) { lastText = txt.trim(); lastRole = "user"; }
    } else if (r.type === "assistant") {
      messages++;
      const m = r.message || {};
      if (m.model) model = m.model;
      const u = m.usage;
      if (u) {
        tin += u.input_tokens || 0;
        tout += u.output_tokens || 0;
        cost += eventCost(u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, m.model);
      }
      let atxt = "";
      for (const b of m.content || []) {
        if (b?.type === "tool_use") { tools++; if (b.name && toolSet.size < 12) toolSet.add(b.name); }
        else if (b?.type === "text" && b.text) atxt += b.text + " ";
      }
      if (atxt.trim()) { lastText = atxt.trim(); lastRole = "assistant"; }
    }
  }
  const project = cwd ? cwd.split("/").filter(Boolean).pop() || cwd : (path.basename(path.dirname(file)).replace(/^-/, "").split("-").pop() || "session");
  const lastActivity = Math.max(lastTs, mtime);
  const derived = title || cleanTitle(lastPrompt) || cleanTitle(firstUser) || project;
  const meta: SessionMeta = {
    id, project, cwd, gitBranch,
    title: derived.slice(0, 80),
    lastPrompt: (cleanTitle(lastPrompt) || cleanTitle(firstUser)).slice(0, 140),
    model, tier: tierOf(model),
    tokensIn: tin, tokensOut: tout, cost, messages, tools,
    toolNames: [...toolSet].slice(0, 8),
    lastRole, tail: lastText.replace(/\s+/g, " ").slice(0, 200),
    lastActivity, active: Date.now() - lastActivity < 120000,
  };
  cache.set(file, { mtime, meta });
  cacheDirty = true;
  return meta;
}

export function listSessions(): SessionMeta[] {
  loadDiskCache(); // hydrate the mtime→meta cache from disk so a cold launch skips re-reading everything
  let dirs: string[];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return []; }
  const out: SessionMeta[] = [];
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d);
    let files: string[];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      const id = f.replace(/\.jsonl$/, "");
      idIndex.set(id, file); // free id→path index for getSession()'s hot polling path
      try {
        const meta = summarize(file, id); // cache-aware: reads the file only when changed
        if (meta.messages === 0) continue;
        if (meta.cwd.includes(ENRICH_MARKER)) continue; // hide the summarizer's own sessions
        out.push(meta);
      } catch { /* skip unreadable */ }
    }
  }
  saveDiskCache(); // persist any newly-parsed files so the next launch is warm
  // Merge the semantic layer (meaningful task title + topic) from the enrichment cache.
  const enr = getEnrichment();
  for (const m of out) { const e = enr[m.id]; if (e) { m.task = e.task; m.goal = e.goal; m.review = e.review; } }
  return out.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 60);
}

export type ToolCallRecord = { name: string; input: any; id?: string; output?: ToolOutput; ok?: boolean };
export type Turn = { role: "user" | "assistant"; text: string; tools: ToolCallRecord[]; ts: number; model?: string };

// Parsed transcripts, cached by file mtime — the chat panel polls this every couple seconds, so an
// unchanged (often huge) transcript must not be re-read or re-parsed each time. Kept on globalThis (dev
// hot-reload survives) AND mirrored to disk (a `bin/serve.sh` restart survives) — same pattern as the
// meta cache above. Before this, a restart meant every open transcript re-tailed + re-parsed from
// scratch, which is exactly what "loading transcript takes forever after a reload" was.
const turnsCache: Map<string, { mtime: number; turns: Turn[] }> = ((globalThis as any).__minamiTurnsCache ||= new Map());
const TURNS_CACHE_FILE = path.join(CACHE_DIR, "turns-cache.json");
const TURNS_CACHE_MAX = 60; // matches the 60-tile cap listSessions() returns — no point caching more
let turnsCacheDirty = false;
function loadTurnsDiskCache(): void {
  const g = globalThis as any;
  if (g.__minamiTurnsCacheLoaded) return;
  g.__minamiTurnsCacheLoaded = true;
  try {
    const obj = JSON.parse(fs.readFileSync(TURNS_CACHE_FILE, "utf8")) as Record<string, { mtime: number; turns: Turn[] }>;
    for (const [f, v] of Object.entries(obj)) if (!turnsCache.has(f)) turnsCache.set(f, v);
  } catch { /* no cache file yet — first run */ }
}
function saveTurnsDiskCache(): void {
  if (!turnsCacheDirty) return;
  turnsCacheDirty = false;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const obj: Record<string, { mtime: number; turns: Turn[] }> = {};
    for (const [f, v] of turnsCache) obj[f] = v;
    fs.writeFileSync(TURNS_CACHE_FILE, JSON.stringify(obj));
  } catch { /* best effort */ }
}
// Map preserves insertion order — delete+reinsert moves an entry to "most recently used" and lets us
// evict the oldest once we're over the cap, so a long-lived server can't grow this file without bound
// (a full transcript tail can be hundreds of KB).
function touchTurnsLRU(file: string, entry: { mtime: number; turns: Turn[] }): void {
  turnsCache.delete(file);
  turnsCache.set(file, entry);
  while (turnsCache.size > TURNS_CACHE_MAX) { const k = turnsCache.keys().next().value; if (!k) break; turnsCache.delete(k); }
}

// id → file path index, built as a side effect of listSessions()'s directory walk (which already scans
// everything) so getSession()'s hot polling path (every ~2.5s per open chat pane) doesn't have to
// re-scan all project dirs with fs.existsSync just to find a file it already found last time.
const idIndex: Map<string, string> = ((globalThis as any).__minamiIdIndex ||= new Map());

export function getSession(id: string): { meta: SessionMeta | null; turns: Turn[] } {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) return { meta: null, turns: [] };
  loadDiskCache();
  loadTurnsDiskCache();
  let found = idIndex.get(id) || "";
  if (found && !fs.existsSync(found)) found = ""; // stale (file moved/deleted) — fall back to a real scan
  if (!found) {
    try {
      for (const d of fs.readdirSync(PROJECTS)) {
        const file = path.join(PROJECTS, d, id + ".jsonl");
        if (fs.existsSync(file)) { found = file; break; }
      }
    } catch { /* none */ }
    if (found) idIndex.set(id, found);
  }
  if (!found) return { meta: null, turns: [] };
  const st = fs.statSync(found);
  const mtime = st.mtimeMs;
  // Meta (token/cost totals) needs the whole file and would defeat the point of tailing — but the chat
  // panel renders titles from the sessions list, not from here, and listSessions keeps meta warm. So
  // serve meta from cache only (best-effort) and never full-read a huge file just to attach it.
  const meta = cache.get(found)?.meta ?? null;
  const tc = turnsCache.get(found);
  // Cache hit — bump LRU order in memory only. No disk write here: this is the path every 2.5s poll
  // takes when nothing changed, and rewriting the cache file on every idle tick would just trade one
  // kind of thrashing for another.
  if (tc && tc.mtime === mtime) { touchTurnsLRU(found, tc); return { meta, turns: tc.turns }; }
  // Turns only need the file's tail — parse that, which keeps opening a long chat fast on first view.
  const raw = readTail(found, st.size);
  const turns: Turn[] = [];
  // tool_use and its tool_result live on two DIFFERENT lines (assistant, then the next user row) — this
  // maps a call's id to the (still-mutable, already-pushed-into-`turns`) record so the result row can
  // attach its output/ok onto the turn that started it, same as the live SSE path does with liveTools.
  const toolIndex = new Map<string, ToolCallRecord>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let r: Row;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== "user" && r.type !== "assistant") continue;
    const c = r.message?.content;
    let text = "";
    const toolz: ToolCallRecord[] = [];
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === "text") text += (text ? "\n" : "") + b.text;
        else if (b?.type === "tool_use") {
          const rec: ToolCallRecord = { name: b.name, input: b.input, id: b.id };
          toolz.push(rec);
          if (b.id) toolIndex.set(b.id, rec);
        } else if (b?.type === "tool_result" && b.tool_use_id) {
          const rec = toolIndex.get(b.tool_use_id);
          if (rec) { rec.output = summarizeToolResult(b.content); rec.ok = !b.is_error; }
        }
      }
    }
    if (text.trim() || toolz.length) {
      turns.push({ role: r.type, text: text.trim(), tools: toolz, ts: Date.parse(r.timestamp || "") || 0, model: r.message?.model });
    }
  }
  const sliced = turns.slice(-120);
  touchTurnsLRU(found, { mtime, turns: sliced });
  turnsCacheDirty = true;
  saveTurnsDiskCache(); // only fires on an actual reparse (mtime changed), so this stays cheap
  return { meta, turns: sliced };
}
