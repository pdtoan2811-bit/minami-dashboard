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
// A single JSONL line can legitimately exceed the tail window (e.g. a tool_result with a big embedded
// base64 image) — if the window contains no newline at all, there's no way to know where a real line
// starts, so widen the window and retry rather than silently feeding a truncated, non-newline-aligned
// blob to the caller (which used to fail JSON.parse on every line and make that whole turn vanish with
// no indication anything was dropped). Capped so a truly pathological file still can't blow up memory.
const TAIL_HARD_CAP = 8 * TAIL_BYTES;
function readTail(file: string, size: number, maxBytes = TAIL_BYTES): string {
  if (size <= maxBytes) return fs.readFileSync(file, "utf8");
  for (let window = maxBytes; ; window *= 4) {
    const fd = fs.openSync(file, "r");
    let s: string;
    try {
      const start = Math.max(0, size - window);
      const len = size - start;
      const buf = Buffer.allocUnsafe(len);
      const read = fs.readSync(fd, buf, 0, len, start);
      s = buf.toString("utf8", 0, read);
    } finally { fs.closeSync(fd); }
    const nl = s.indexOf("\n"); // the first line is probably truncated — drop it
    if (nl >= 0) return s.slice(nl + 1);
    if (window >= TAIL_HARD_CAP || window >= size) return ""; // give up — a single line this huge is
    // vanishingly unlikely and not worth reading the whole file over; caller treats "" as no new turns.
  }
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

// Generic bounded LRU: reinsert on every touch (hit or write) so recency reflects actual access, not
// just insertion order, then evict the oldest once over `max`. Used for both the meta cache and the
// id→path index below — without this, either Map grows for the life of the process, one entry per
// distinct session file ever seen (weeks/months of usage), a slow but real unbounded-memory leak.
function touchLRU<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) { const k = map.keys().next().value; if (k !== undefined) map.delete(k); }
}

// Running totals for one transcript file, carried across incremental parses (see summarize() below).
// toolSet is a plain capped array (not a Set) so it round-trips through JSON for the disk cache as-is.
type ParseAccum = {
  title: string; lastPrompt: string; model: string; cwd: string; gitBranch: string;
  firstUser: string; lastText: string; lastRole: string;
  tin: number; tout: number; cost: number; messages: number; tools: number;
  toolSet: string[];
  lastTs: number;
  lineLeftover: string; // trailing partial JSON line (no newline yet) carried to the next parse
  byteLeftoverB64: string; // trailing INCOMPLETE utf-8 byte sequence from the last raw read, base64
};
function freshAccum(): ParseAccum {
  return {
    title: "", lastPrompt: "", model: "", cwd: "", gitBranch: "", firstUser: "", lastText: "", lastRole: "",
    tin: 0, tout: 0, cost: 0, messages: 0, tools: 0, toolSet: [], lastTs: 0, lineLeftover: "", byteLeftoverB64: "",
  };
}

type CacheEntry = { mtime: number; size: number; accum: ParseAccum; meta: SessionMeta };

// Metadata cache, keyed by file + mtime + size. Kept on globalThis so a Next dev hot-reload doesn't
// wipe it, and mirrored to disk so a fresh server launch doesn't have to re-read+parse every (often
// huge) JSONL just to build the grid — that cold read was ~9s and blocked the whole UI from rendering.
const cache: Map<string, CacheEntry> = ((globalThis as any).__minamiMetaCache ||= new Map());
const META_CACHE_MAX = 500; // generous vs. the 60-tile grid — bounds memory without evicting anything
                            // the user is actually likely to look back at soon.
const CACHE_DIR = path.join(os.homedir(), ".minami-bento");
const META_CACHE_FILE = path.join(CACHE_DIR, "meta-cache.json");
let cacheDirty = false;
function loadDiskCache(): void {
  const g = globalThis as any;
  if (g.__minamiMetaCacheLoaded) return;
  g.__minamiMetaCacheLoaded = true;
  try {
    // Tolerate a pre-upgrade cache file (entries without `size`/`accum`): summarize() below treats a
    // missing `accum` as "no incremental state" and does one full reparse per file, then upgrades it.
    const obj = JSON.parse(fs.readFileSync(META_CACHE_FILE, "utf8")) as Record<string, Partial<CacheEntry>>;
    for (const [f, v] of Object.entries(obj)) if (!cache.has(f) && v && typeof v.mtime === "number") cache.set(f, v as CacheEntry);
  } catch { /* no cache file yet — first run */ }
}
function saveDiskCache(): void {
  if (!cacheDirty) return;
  cacheDirty = false;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const obj: Record<string, CacheEntry> = {};
    for (const [f, v] of cache) obj[f] = v;
    // Atomic write: a torn/partial write (crash, or two processes writing at once — e.g. `next dev` and
    // `next start` both pointed at the same home dir, which has happened before on this project) would
    // otherwise leave a file that fails JSON.parse on the next read, silently dropping the whole cache.
    // write-then-rename means a reader only ever sees a fully-old or fully-new file, never a partial one.
    const tmp = `${META_CACHE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, META_CACHE_FILE);
  } catch { /* best effort */ }
}

// Split off a trailing INCOMPLETE utf-8 multi-byte sequence (0-3 bytes) so it can be carried over to
// the next read instead of being decoded now — otherwise Buffer#toString silently replaces a sequence
// truncated mid-character with U+FFFD, corrupting whatever text straddled this read's boundary.
function splitTrailingIncompleteUtf8(buf: Buffer): { complete: Buffer; leftover: Buffer } {
  if (!buf.length) return { complete: buf, leftover: Buffer.alloc(0) };
  let i = buf.length - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && (buf[i] & 0b11000000) === 0b10000000) { i--; cont++; } // skip continuation bytes
  if (i < 0) return { complete: Buffer.alloc(0), leftover: buf }; // pathological: all continuation bytes
  const lead = buf[i];
  const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (seqLen > buf.length - i) return { complete: buf.subarray(0, i), leftover: buf.subarray(i) };
  return { complete: buf, leftover: Buffer.alloc(0) };
}

function readNewBytes(file: string, start: number, end: number): Buffer {
  if (end <= start) return Buffer.alloc(0);
  const fd = fs.openSync(file, "r");
  try {
    const len = end - start;
    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, read);
  } finally { fs.closeSync(fd); }
}

// Fold one JSONL line into the running accumulator — same field logic as the original full-file parse,
// just writing into `acc` instead of local variables so it can run over a partial (appended-only) chunk.
function foldLine(acc: ParseAccum, line: string): void {
  if (!line.trim()) return;
  let r: Row;
  try { r = JSON.parse(line); } catch { return; }
  if (r.cwd) acc.cwd = r.cwd;
  if (r.gitBranch) acc.gitBranch = r.gitBranch;
  if (r.timestamp) { const ms = Date.parse(r.timestamp); if (ms > acc.lastTs) acc.lastTs = ms; }
  if (r.type === "custom-title" && r.customTitle) acc.title = r.customTitle;
  else if (r.type === "last-prompt" && r.lastPrompt) acc.lastPrompt = r.lastPrompt;
  else if (r.type === "user") {
    acc.messages++;
    const c = r.message?.content;
    let txt = "";
    if (typeof c === "string") txt = c;
    else if (Array.isArray(c)) txt = c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ");
    if (txt.trim() && !acc.firstUser) acc.firstUser = txt.trim();
    if (txt.trim()) { acc.lastText = txt.trim(); acc.lastRole = "user"; }
  } else if (r.type === "assistant") {
    acc.messages++;
    const m = r.message || {};
    if (m.model) acc.model = m.model;
    const u = m.usage;
    if (u) {
      acc.tin += u.input_tokens || 0;
      acc.tout += u.output_tokens || 0;
      acc.cost += eventCost(u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, m.model);
    }
    let atxt = "";
    for (const b of m.content || []) {
      if (b?.type === "tool_use") { acc.tools++; if (b.name && acc.toolSet.length < 12 && !acc.toolSet.includes(b.name)) acc.toolSet.push(b.name); }
      else if (b?.type === "text" && b.text) atxt += b.text + " ";
    }
    if (atxt.trim()) { acc.lastText = atxt.trim(); acc.lastRole = "assistant"; }
  }
}

function buildMeta(id: string, file: string, acc: ParseAccum, mtime: number): SessionMeta {
  const project = acc.cwd ? acc.cwd.split("/").filter(Boolean).pop() || acc.cwd : (path.basename(path.dirname(file)).replace(/^-/, "").split("-").pop() || "session");
  const lastActivity = Math.max(acc.lastTs, mtime);
  const derived = acc.title || cleanTitle(acc.lastPrompt) || cleanTitle(acc.firstUser) || project;
  return {
    id, project, cwd: acc.cwd, gitBranch: acc.gitBranch,
    title: derived.slice(0, 80),
    lastPrompt: (cleanTitle(acc.lastPrompt) || cleanTitle(acc.firstUser)).slice(0, 140),
    model: acc.model, tier: tierOf(acc.model),
    tokensIn: acc.tin, tokensOut: acc.tout, cost: acc.cost, messages: acc.messages, tools: acc.tools,
    toolNames: acc.toolSet.slice(0, 8),
    lastRole: acc.lastRole, tail: acc.lastText.replace(/\s+/g, " ").slice(0, 200),
    lastActivity, active: Date.now() - lastActivity < 120000,
  };
}

// Summarize a transcript into totals for the grid. INCREMENTAL by design: transcripts are polled every
// couple of seconds, and an ACTIVELY STREAMING session's mtime changes on almost every poll — the
// original version did a full fs.readFileSync + re-parse of the WHOLE file on every such change, which
// for a real 29-61MB transcript meant repeatedly blocking Node's single event loop (every request, every
// pane, every SSE broadcast) for as long as that session stayed live. Now only the bytes appended since
// the last parse are read and folded into the running accumulator, so cost is proportional to what
// changed, not to the file's total size.
function summarize(file: string, id: string, raw?: string): SessionMeta {
  const st = fs.statSync(file);
  const mtime = st.mtimeMs, size = st.size;
  const cached = cache.get(file);
  // Unchanged (both mtime AND size match) — cheap path, no file read at all. Checking size too (not
  // just mtime) guards against coarse filesystem mtime resolution letting a real append through as a
  // false "unchanged" hit, which would otherwise serve stale tokens/cost indefinitely.
  if (cached && cached.mtime === mtime && cached.size === size) {
    touchLRU(cache, file, cached, META_CACHE_MAX);
    return { ...cached.meta, active: Date.now() - cached.meta.lastActivity < 120000 };
  }

  // Full reparse when: an explicit `raw` override is given (whole-file content, no prior caller today
  // but keep the contract), there's no usable prior state (first time, or an old pre-upgrade cache
  // entry with no `accum`), or the file got SMALLER than what we'd already parsed (rotated/truncated —
  // our incremental offset would be reading garbage past the new end).
  const canIncremental = raw === undefined && !!cached && !!cached.accum && cached.size <= size;
  const acc: ParseAccum = canIncremental && cached ? cached.accum : freshAccum();
  const readStart = canIncremental && cached ? cached.size : 0;

  if (raw !== undefined) {
    acc.lineLeftover = "";
    acc.byteLeftoverB64 = "";
    for (const line of raw.split("\n")) foldLine(acc, line);
  } else {
    const newBuf = readNewBytes(file, readStart, size);
    const leftoverBytes = acc.byteLeftoverB64 ? Buffer.from(acc.byteLeftoverB64, "base64") : Buffer.alloc(0);
    const combinedBuf = leftoverBytes.length ? Buffer.concat([leftoverBytes, newBuf]) : newBuf;
    const { complete, leftover } = splitTrailingIncompleteUtf8(combinedBuf);
    acc.byteLeftoverB64 = leftover.length ? leftover.toString("base64") : "";
    const text = acc.lineLeftover + complete.toString("utf8");
    const parts = text.split("\n");
    // If this chunk doesn't end in a newline, the last part is an as-yet-incomplete line — hold it for
    // next time instead of failing to parse it now. If it DOES end in "\n", split() leaves a trailing
    // "" element to drop.
    acc.lineLeftover = text.endsWith("\n") ? "" : (parts.pop() || "");
    if (text.endsWith("\n")) parts.pop();
    for (const line of parts) foldLine(acc, line);
  }

  const meta = buildMeta(id, file, acc, mtime);
  touchLRU(cache, file, { mtime, size, accum: acc, meta }, META_CACHE_MAX);
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
      touchLRU(idIndex, id, file, ID_INDEX_MAX); // free id→path index for getSession()'s hot polling path
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
// Delete+reinsert moves an entry to "most recently used" and lets us evict the oldest once we're over
// the cap, so a long-lived server can't grow this file without bound (a full transcript tail can be
// hundreds of KB). Thin wrapper over the generic touchLRU above, kept for its existing call sites.
function touchTurnsLRU(file: string, entry: { mtime: number; turns: Turn[] }): void {
  touchLRU(turnsCache, file, entry, TURNS_CACHE_MAX);
}

// id → file path index, built as a side effect of listSessions()'s directory walk (which already scans
// everything) so getSession()'s hot polling path (every ~2.5s per open chat pane) doesn't have to
// re-scan all project dirs with fs.existsSync just to find a file it already found last time. Bounded
// LRU for the same reason as the meta cache above — otherwise it's one more Map that only ever grows
// for the life of the process, over every distinct session id ever seen.
const idIndex: Map<string, string> = ((globalThis as any).__minamiIdIndex ||= new Map());
const ID_INDEX_MAX = 2000; // tiny entries (id → path string) — generous cap costs almost nothing

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
    if (found) touchLRU(idIndex, id, found, ID_INDEX_MAX);
  } else {
    touchLRU(idIndex, id, found, ID_INDEX_MAX); // bump recency on every hit too, not just on insert
  }
  if (!found) return { meta: null, turns: [] };
  const st = fs.statSync(found);
  const mtime = st.mtimeMs;
  // Meta (token/cost totals) needs the whole file and would defeat the point of tailing — but the chat
  // panel renders titles from the sessions list, not from here, and listSessions keeps meta warm. So
  // serve meta from cache only (best-effort) and never full-read a huge file just to attach it.
  const metaEntry = cache.get(found);
  if (metaEntry) touchLRU(cache, found, metaEntry, META_CACHE_MAX);
  const meta = metaEntry?.meta ?? null;
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
