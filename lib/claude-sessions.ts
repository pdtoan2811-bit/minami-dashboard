/* eslint-disable @typescript-eslint/no-explicit-any */
// Server-only: read Claude Code session transcripts (~/.claude/projects/<enc-cwd>/<id>.jsonl) and
// summarize them for the Bento mirror. Zero deps — Phase 1 observes real terminal/CLI sessions
// read-only. (Driving sessions = Phase 2 via @anthropic-ai/claude-agent-sdk.)
import crypto from "node:crypto";
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

// Does this message say enough to NAME a conversation?
//
// "First prompt" is the right rule for a title, but the first prompt is often not a topic: chats open
// on "yes", "ok", "continue", "do it" — an answer to something said elsewhere, or the nudge that
// restarts yesterday's work. Measured on a real transcript, taking the opener literally titled a
// 46-prompt session "yes". So the seed walks forward to the first message that actually describes
// something, and freezes there.
//
// The test is length, not vocabulary: a keyword list ("fix", "add", "why"…) would need maintaining and
// would still miss the next phrasing, while "long enough to be a description" is stable across
// languages — this box is used in English and Vietnamese, and neither gets a hand-tuned stopword list.
function looksLikeATopic(s: string): boolean {
  const t = s.trim();
  return t.length >= 20 || t.split(/\s+/).length >= 4;
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
  // The earliest user message that actually names a topic (see looksLikeATopic), and a latch saying
  // the search is over. The latch exists for accumulators restored from a cache written before this
  // field did — their early messages are no longer in hand, so the seed is settled once from what IS
  // known (`firstUser`) and closed, rather than letting whatever message arrives next claim it and
  // freeze the title on something from the middle of the conversation.
  titleSeed: string; seedClosed: boolean;
  tin: number; tout: number; cost: number; messages: number; tools: number;
  toolSet: string[];
  lastTs: number;
  lineLeftover: string; // trailing partial JSON line (no newline yet) carried to the next parse
  byteLeftoverB64: string; // trailing INCOMPLETE utf-8 byte sequence from the last raw read, base64
};
function freshAccum(): ParseAccum {
  return {
    title: "", lastPrompt: "", model: "", cwd: "", gitBranch: "", firstUser: "", lastText: "", lastRole: "",
    titleSeed: "", seedClosed: false,
    tin: 0, tout: 0, cost: 0, messages: 0, tools: 0, toolSet: [], lastTs: 0, lineLeftover: "", byteLeftoverB64: "",
  };
}

type CacheEntry = { mtime: number; size: number; head: string; accum: ParseAccum; meta: SessionMeta; dv?: number; pv?: number };

// Bumped whenever buildMeta's DERIVATION changes rather than its inputs. An entry caches both the
// parse state (`accum`) and the `meta` derived from it, and a transcript that never grows again is
// never re-derived — so a change to how a title is chosen would otherwise only reach sessions that
// happened to receive another message, leaving the board a permanent mix of the old rule and the new.
// Re-deriving costs no file I/O at all: buildMeta is pure over state we already hold on disk.
const META_DERIVATION_VERSION = 3;

// Bumped whenever a field's PARSING changes — a stronger invalidation than META_DERIVATION_VERSION.
// A derivation change can be back-fixed from the cached `accum` (migrateAccum + re-derive, no I/O); a
// parse change cannot, because the raw rows that fed `accum` are already folded away. So a stale `pv`
// drops the entry entirely and forces one full reparse from offset 0. v1: meta.cwd froze on the launch
// cwd instead of the last (fixes drifted-cwd resumes failing with "No conversation found").
const PARSE_VERSION = 1;

// Fingerprint of a file's first `len` bytes — cheap (len is capped small) and used ONLY to tell "this
// file was purely appended to" apart from "this file was truncated and rewritten, but happens to have
// ended up the same size or bigger" (mtime+size alone can't distinguish those). A real append can never
// change bytes that already existed, so the fingerprint of a stable prefix is invariant across appends
// and changes the instant something rewrites that prefix.
function headFingerprint(file: string, len: number): string {
  if (len <= 0) return "";
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, 0);
    return crypto.createHash("sha1").update(buf.subarray(0, read)).digest("hex");
  } finally { fs.closeSync(fd); }
}
const HEAD_FINGERPRINT_BYTES = 4096;

// Metadata cache, keyed by file + mtime + size. Kept on globalThis so a Next dev hot-reload doesn't
// wipe it, and mirrored to disk so a fresh server launch doesn't have to re-read+parse every (often
// huge) JSONL just to build the grid — that cold read was ~9s and blocked the whole UI from rendering.
const cache: Map<string, CacheEntry> = ((globalThis as any).__minamiMetaCache ||= new Map());
const META_CACHE_MAX = 500; // generous vs. the 60-tile grid — bounds memory without evicting anything
                            // the user is actually likely to look back at soon.
const CACHE_DIR = path.join(os.homedir(), ".minami-bento");
const META_CACHE_FILE = path.join(CACHE_DIR, "meta-cache.json");
let cacheDirty = false;
// Bring an accumulator written before `titleSeed` existed up to the current shape, WITHOUT re-reading
// its transcript. Only `firstUser` survives from that session's opening, so the seed is decided from
// it and then latched shut — the alternative, leaving the search open, would let the next message the
// session happens to receive become its permanent title, which is a worse failure than no seed at all.
function migrateAccum(acc: ParseAccum): void {
  if (typeof acc.seedClosed === "boolean") return;
  const c = cleanTitle(acc.firstUser || "");
  acc.titleSeed = c && looksLikeATopic(c) ? c : "";
  acc.seedClosed = true;
}
function loadDiskCache(): void {
  const g = globalThis as any;
  if (g.__minamiMetaCacheLoaded) return;
  g.__minamiMetaCacheLoaded = true;
  try {
    // Tolerate a pre-upgrade cache file (entries without `size`/`accum`): summarize() below treats a
    // missing `accum` as "no incremental state" and does one full reparse per file, then upgrades it.
    const obj = JSON.parse(fs.readFileSync(META_CACHE_FILE, "utf8")) as Record<string, Partial<CacheEntry>>;
    for (const [f, v] of Object.entries(obj)) {
      if (cache.has(f) || !v || typeof v.mtime !== "number") continue;
      const e = v as CacheEntry;
      // Stale PARSE version → the cached accum was built by parse logic this build no longer trusts and
      // can't be repaired from (the raw rows are gone). Drop the entry so summarize() does a full reparse
      // from offset 0. Skipped BEFORE the cheap mtime/size hit in summarize() can serve its stale meta.
      if (e.pv !== PARSE_VERSION) continue;
      // Stale derivation → rebuild `meta` from the accumulator we already have, in memory. An entry
      // with no `accum` (pre-upgrade) is left alone: summarize() gives it a full reparse on first use.
      if (e.dv !== META_DERIVATION_VERSION && e.accum && e.meta?.id) {
        migrateAccum(e.accum);
        e.meta = buildMeta(e.meta.id, f, e.accum, e.mtime);
        e.dv = META_DERIVATION_VERSION;
        cacheDirty = true;
      }
      cache.set(f, e);
    }
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
  // The FIRST cwd, not the last. A transcript lives in ~/.claude/projects/<enc(launch cwd)>/, fixed at
  // creation — but a session can `cd` mid-run (the CLI stamps the current cwd on every row), so taking
  // the last cwd made meta.cwd drift to whatever subdirectory it ended in. `--resume` is scoped to the
  // working directory the file is filed under, so continuing a drifted session sent the CLI hunting in
  // enc(subdir)/ — where the file isn't — and it died with "No conversation found with session ID:".
  // The launch cwd is the one that encodes back to the file's own directory; freeze on it.
  if (r.cwd && !acc.cwd) acc.cwd = r.cwd;
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
    if (txt.trim() && !acc.seedClosed && !acc.titleSeed) {
      const c = cleanTitle(txt.trim());
      if (c && looksLikeATopic(c)) acc.titleSeed = c;
    }
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
  // FIRST prompt, not the last one. The CLI appends a `last-prompt` row on every message you send, so
  // preferring it meant a conversation's NAME changed each turn — the tile, the tab and the switcher
  // entry all renamed themselves mid-chat, and a chat you were looking for was filed under whatever
  // you happened to say to it most recently. Measured on one real session: eight successive titles,
  // ending on "pending them all tasks and get my app deploy…" for a chat that opened on something
  // else entirely. A name is what a thing is about; that's fixed at the opening ask.
  //
  // Still ordered AFTER a `custom-title`: an explicit rename outranks any derivation.
  //
  // The raw first message is deliberately NOT a step in this chain — only `titleSeed`, which is the
  // first message that carries a topic at all. A session can open on "yes", a `<local-command…>` echo
  // or a compaction preamble, and naming it "yes" is worse than the churn this whole change removes.
  // So a title is frozen only when there is something worth freezing; failing that we fall back to the
  // latest prompt, which at least describes something, and accept that it moves.
  const derived = acc.title || acc.titleSeed || cleanTitle(acc.lastPrompt) || project;
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
  // entry with no `accum`), the file got SMALLER than what we'd already parsed (rotated/truncated — our
  // incremental offset would be reading garbage past the new end), OR the file's head no longer matches
  // what we fingerprinted last time. That last check catches a same-or-larger-size TRUNCATE+REWRITE
  // (mtime/size alone can look exactly like a pure append when the rewrite happens to land on an equal
  // or bigger size) — without it, readNewBytes() would read an arbitrary slice of unrelated new content
  // as if it were an appended suffix, foldLine() would silently fold garbage into `acc` forever (it's
  // never reset on this path), and the session's totals/title would be permanently wrong with no error.
  const headOk = !!cached && (cached.size === 0 || cached.head === headFingerprint(file, Math.min(cached.size, HEAD_FINGERPRINT_BYTES)));
  const canIncremental = raw === undefined && !!cached && !!cached.accum && cached.size <= size && headOk;
  const acc: ParseAccum = canIncremental && cached ? cached.accum : freshAccum();
  // Belt and braces with loadDiskCache's own pass: the cache file is shared by every process pointed at
  // this home dir (prod, a preview build, `next dev`), so an entry can arrive carrying a version stamp
  // this build didn't write. migrateAccum is idempotent and keyed on the FIELD, not the stamp.
  if (canIncremental) migrateAccum(acc);
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
  // Fingerprint AFTER parsing, over the file as it stands now — a pure append never touches these bytes,
  // so this stays stable across future polls and only changes if something rewrites the file's start.
  const head = headFingerprint(file, Math.min(size, HEAD_FINGERPRINT_BYTES));
  touchLRU(cache, file, { mtime, size, head, accum: acc, meta, dv: META_DERIVATION_VERSION, pv: PARSE_VERSION }, META_CACHE_MAX);
  cacheDirty = true;
  return meta;
}

// Generous headroom over the eventual top-60 cut below — some candidates in the window get dropped
// (0 messages, the enrichment summarizer's own scratch sessions) so the window needs slack, but it must
// stay a small FIXED number regardless of how many transcripts pile up on disk over time (see below).
const CANDIDATE_WINDOW = 150;

export function listSessions(): SessionMeta[] {
  loadDiskCache(); // hydrate the mtime→meta cache from disk so a cold launch skips re-reading everything
  let dirs: string[];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return []; }
  // Stat-only pass first — cheap (no file content read) — so we can pick the ~150 most recently active
  // transcripts BEFORE calling summarize() on any of them. This machine already has 375 real session
  // files and climbing; summarize()-ing every single one on every poll (the old behavior) means one
  // sweep touches more distinct files than META_CACHE_MAX (500) holds once the total count crosses that
  // line, which silently evicts — and therefore forces a full, expensive re-parse of — files from the
  // very same sweep that just cached them. That's the "every poll blocks the event loop" failure mode
  // commit 6505ed2 fixed, reintroduced via cache thrash instead of a busted incremental parser. mtime is
  // a safe proxy for recency here (any activity, including an in-progress stream, touches it), so this
  // can't wrongly drop a genuinely active session outside the window.
  const candidates: { file: string; id: string; mtime: number }[] = [];
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d);
    let files: string[];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      const id = f.replace(/\.jsonl$/, "");
      touchLRU(idIndex, id, file, ID_INDEX_MAX); // free id→path index for getSession()'s hot polling path
      try { candidates.push({ file, id, mtime: fs.statSync(file).mtimeMs }); } catch { /* gone mid-scan */ }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const windowed = candidates.length > CANDIDATE_WINDOW ? candidates.slice(0, CANDIDATE_WINDOW) : candidates;

  const out: SessionMeta[] = [];
  for (const { file, id } of windowed) {
    try {
      const meta = summarize(file, id); // cache-aware: reads the file only when changed
      if (meta.messages === 0) continue;
      if (meta.cwd.includes(ENRICH_MARKER)) continue; // hide the summarizer's own sessions
      out.push(meta);
    } catch { /* skip unreadable */ }
  }
  saveDiskCache(); // persist any newly-parsed files so the next launch is warm
  // Merge the semantic layer (meaningful task title + topic) from the enrichment cache.
  const enr = getEnrichment();
  for (const m of out) { const e = enr[m.id]; if (e) { m.task = e.task; m.goal = e.goal; m.review = e.review; } }
  return out.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 60);
}

/**
 * Every session recorded under a specific set of working directories, newest first.
 *
 * Deliberately NOT listSessions() with a filter. That one exists to paint the bento grid: it windows
 * to the ~150 most recently touched transcripts box-wide and then cuts to 60, which is right for "what
 * am I working on" and wrong for "everything this agent has ever done" — an agent whose folder went
 * quiet for a fortnight would show an empty history while its transcripts sat on disk untouched. Here
 * the cwd set is the filter, applied to the DIRECTORY rather than to a global recency window, so the
 * cost scales with the folders asked for instead of with the box's total session count.
 */
export function listSessionsIn(cwds: string[], limit = 200): SessionMeta[] {
  loadDiskCache();
  const seen = new Set<string>();
  const candidates: { file: string; id: string; mtime: number }[] = [];
  for (const cwd of cwds) {
    // The CLI's own encoding: every non-alphanumeric byte of the path becomes a dash.
    const dir = path.join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    let files: string[];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, "");
      if (seen.has(id)) continue; // two cwds can encode to one dir (e.g. `a/b` and `a-b`)
      seen.add(id);
      const file = path.join(dir, f);
      touchLRU(idIndex, id, file, ID_INDEX_MAX);
      try { candidates.push({ file, id, mtime: fs.statSync(file).mtimeMs }); } catch { /* gone mid-scan */ }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const out: SessionMeta[] = [];
  for (const { file, id } of candidates.slice(0, limit)) {
    try {
      const meta = summarize(file, id);
      if (meta.messages === 0) continue;
      if (meta.cwd.includes(ENRICH_MARKER)) continue;
      out.push(meta);
    } catch { /* skip unreadable */ }
  }
  saveDiskCache();
  const enr = getEnrichment();
  for (const m of out) { const e = enr[m.id]; if (e) { m.task = e.task; m.goal = e.goal; m.review = e.review; } }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

export type ToolCallRecord = { name: string; input: any; id?: string; output?: ToolOutput; ok?: boolean };
// `off` is the byte offset of the JSONL line that started this turn. It's what makes history pageable:
// a window's lower bound is exactly turns[0].off, so "give me what came before" is a precise byte
// request rather than a guess, and trimming a window from the front stays self-consistent.
export type Turn = { role: "user" | "assistant"; text: string; tools: ToolCallRecord[]; ts: number; model?: string; off?: number };
export type SessionPage = { meta: SessionMeta | null; turns: Turn[]; start: number; hasMore: boolean };

// WHY WINDOWS AND NOT A TAIL
// The old code read a fixed 1.5MB tail and then `slice(-120)`, which made everything before that
// permanently unreachable — on a 64MB/1813-turn transcript only ~5% of the conversation could ever be
// displayed, with no marker saying so. The caps themselves were right (full-reading 64MB on a 2.5s poll
// is what commit 6505ed2 fixed for metadata); what was missing is that a bounded read must be a PAGE,
// not the only shot. Transcripts are append-only, so any window below the live tail is immutable and can
// be cached forever with no invalidation — history costs one read per page, once, ever.
const WINDOW_BYTES = 512_000;      // first read: small, because only ~40 turns render initially
const WINDOW_MIN_TURNS = 60;       // ...but widen if the window is all giant lines (base64 tool results)
const WINDOW_HARD_CAP = 8 * WINDOW_BYTES;
const LIVE_WINDOW_TURNS = 400;     // in-memory cap for the growing tail; older turns are re-fetchable
const DISK_WINDOW_TURNS = 60;      // what gets persisted — enough to paint instantly after a restart

// Parse JSONL lines into turns, tracking each line's byte offset. `startOff` is the file offset of
// lines[0]; every line advances it by its own byte length + 1 for the newline.
function parseLines(lines: string[], startOff: number, turns: Turn[], toolIndex: Map<string, ToolCallRecord>): number {
  let off = startOff;
  for (const line of lines) {
    const lineOff = off;
    off += Buffer.byteLength(line, "utf8") + 1;
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
          // tool_use and its tool_result live on two DIFFERENT lines (assistant, then the next user row),
          // so the result row mutates the already-pushed record its call created — same as the live SSE
          // path does with liveTools. Across an incremental fold the call may be in a previous chunk,
          // which is why the index is rebuilt from the tail of `turns` rather than started empty.
          const rec = toolIndex.get(b.tool_use_id);
          if (rec) { rec.output = summarizeToolResult(b.content); rec.ok = !b.is_error; }
        }
      }
    }
    if (text.trim() || toolz.length) {
      turns.push({ role: r.type, text: text.trim(), tools: toolz, ts: Date.parse(r.timestamp || "") || 0, model: r.message?.model, off: lineOff });
    }
  }
  return off;
}

function rebuildToolIndex(turns: Turn[], lookback = 20): Map<string, ToolCallRecord> {
  const m = new Map<string, ToolCallRecord>();
  for (const t of turns.slice(-lookback)) for (const tc of t.tools) if (tc.id) m.set(tc.id, tc);
  return m;
}

// Read backwards from `end` until we have `minTurns` turns (or run out of file / hit the cap). The
// newline search runs on the BUFFER, not the decoded string: slicing mid-file almost always lands
// inside a UTF-8 sequence, and computing the post-drop byte offset from a string index that contains
// replacement characters would be silently wrong — which is exactly the kind of off-by-N that makes a
// page overlap or skip turns.
function readTurnsBack(file: string, end: number, minTurns: number): { turns: Turn[]; start: number } {
  let window = WINDOW_BYTES;
  for (;;) {
    const start0 = Math.max(0, end - window);
    const buf = readNewBytes(file, start0, end);
    let body = buf;
    let bodyStart = start0;
    if (start0 > 0) {
      const nl = buf.indexOf(0x0a); // first line is partial — it belongs to the previous page
      if (nl < 0) {
        // A single JSONL line longer than the whole window (a big embedded base64 tool result). Widen
        // rather than feed a non-newline-aligned blob to the parser, which would drop the turn silently.
        if (window >= WINDOW_HARD_CAP) return { turns: [], start: start0 };
        window *= 4;
        continue;
      }
      body = buf.subarray(nl + 1);
      bodyStart = start0 + nl + 1;
    }
    const turns: Turn[] = [];
    parseLines(body.toString("utf8").split("\n"), bodyStart, turns, new Map());
    if (turns.length >= minTurns || bodyStart === 0 || window >= WINDOW_HARD_CAP) return { turns, start: bodyStart };
    window *= 4;
  }
}

type TurnsEntry = {
  mtime: number;
  size: number;            // file size at last parse — the window's upper bound
  head: string;            // rewrite guard, same contract as the meta cache's fingerprint
  start: number;           // window's lower bound; > 0 means older history exists on disk
  turns: Turn[];
  lineLeftover: string;    // trailing partial line held for the next fold
  byteLeftoverB64: string; // trailing partial UTF-8 sequence, ditto
};

// Parsed transcripts, cached by file — the chat panel polls this every couple seconds, so an unchanged
// (often huge) transcript must not be re-read or re-parsed each time. Kept on globalThis (dev
// hot-reload survives) AND mirrored to disk (a `bin/serve.sh` restart survives) — same pattern as the
// meta cache above. Before this, a restart meant every open transcript re-tailed + re-parsed from
// scratch, which is exactly what "loading transcript takes forever after a reload" was.
const turnsCache: Map<string, TurnsEntry> = ((globalThis as any).__minamiTurnsCache2 ||= new Map());
const TURNS_CACHE_FILE = path.join(CACHE_DIR, "turns-cache.json");
const TURNS_CACHE_MAX = 60; // matches the 60-tile cap listSessions() returns — no point caching more
let turnsCacheDirty = false;

// Trim a window to its last `maxTurns`, keeping `start` exact — turns[0].off IS the new lower bound, so
// a trimmed window is still a valid page and `hasMore` stays truthful.
function trimWindow(e: TurnsEntry, maxTurns: number): TurnsEntry {
  if (e.turns.length <= maxTurns) return e;
  const turns = e.turns.slice(-maxTurns);
  return { ...e, turns, start: turns[0]?.off ?? e.start };
}

// A turn count is the wrong budget for the DISK copy: tool inputs/outputs dominate an entry's size, so
// 60 turns of a screenshot-heavy session serialises to hundreds of KB while 60 turns of plain chat is a
// few. Measured at 60 turns/entry the cache file was still ~450KB per session — 27MB at a full 60
// entries, worse than the 8MB this was meant to shrink. Budget by serialised bytes instead, so one
// unusual session can't inflate a file that gets written synchronously.
const DISK_ENTRY_MAX_BYTES = 64_000;
function trimForDisk(e: TurnsEntry): TurnsEntry {
  let out = trimWindow(e, DISK_WINDOW_TURNS);
  let n = out.turns.length;
  while (n > 4 && JSON.stringify(out).length > DISK_ENTRY_MAX_BYTES) {
    n = Math.floor(n / 2);
    out = trimWindow(out, n);
  }
  return out;
}

function loadTurnsDiskCache(): void {
  const g = globalThis as any;
  if (g.__minamiTurnsCacheLoaded2) return;
  g.__minamiTurnsCacheLoaded2 = true;
  try {
    const obj = JSON.parse(fs.readFileSync(TURNS_CACHE_FILE, "utf8")) as Record<string, TurnsEntry>;
    // Only entries written by this (windowed) format are usable: an older entry has no `start`/`off`,
    // so folding new bytes onto it would produce a window whose claimed lower bound is a lie.
    for (const [f, v] of Object.entries(obj)) {
      if (!turnsCache.has(f) && v && typeof v.start === "number" && typeof v.size === "number") turnsCache.set(f, v);
    }
  } catch { /* no cache file yet — first run */ }
}

// THROTTLED. This used to run on every reparse, and a reparse happens on essentially every 2.5s poll of
// a LIVE session — meaning a JSON.stringify of all 60 cached sessions plus a synchronous multi-megabyte
// writeFileSync, on Node's single event loop, several times a second, exactly when the dashboard is
// busiest. The file is a warm-start optimisation; it does not need to be current to the second.
const TURNS_SAVE_INTERVAL = 15_000;
let turnsSaveTimer: NodeJS.Timeout | null = null;
let turnsLastSaveAt = 0;
function saveTurnsDiskCache(): void {
  if (!turnsCacheDirty) return;
  turnsCacheDirty = false;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const obj: Record<string, TurnsEntry> = {};
    // Persist only the last DISK_WINDOW_TURNS per session. Enough to paint a pane instantly on restart,
    // and it keeps this file small — it had grown to ~8MB of full windows, which is what made the
    // synchronous write above expensive in the first place. A trimmed window is still self-consistent
    // (see trimWindow), so the next poll can fold new bytes straight onto it.
    for (const [f, v] of turnsCache) obj[f] = trimForDisk(v);
    fs.writeFileSync(TURNS_CACHE_FILE, JSON.stringify(obj));
  } catch { /* best effort */ }
}
function scheduleTurnsDiskSave(): void {
  if (turnsSaveTimer) return;
  const wait = Math.max(0, TURNS_SAVE_INTERVAL - (Date.now() - turnsLastSaveAt));
  turnsSaveTimer = setTimeout(() => {
    turnsSaveTimer = null;
    turnsLastSaveAt = Date.now();
    saveTurnsDiskCache();
  }, wait);
  // Never keep the process alive just to flush a cache file.
  if (typeof turnsSaveTimer.unref === "function") turnsSaveTimer.unref();
}
// Delete+reinsert moves an entry to "most recently used" and lets us evict the oldest once we're over
// the cap, so a long-lived server can't grow this file without bound (a full transcript tail can be
// hundreds of KB). Thin wrapper over the generic touchLRU above, kept for its existing call sites.
function touchTurnsLRU(file: string, entry: TurnsEntry): void {
  touchLRU(turnsCache, file, entry, TURNS_CACHE_MAX);
}

// Cold history pages, keyed by (file, requested upper bound). A page below the live tail is IMMUTABLE —
// appends never rewrite existing bytes — so there is no mtime in this key and no invalidation: fetch a
// given page once, ever. The head fingerprint is the sole escape hatch, for a truncate-and-rewrite.
// Deliberately NOT persisted to disk: the disk cache exists to make a cold start fast for the grid, and
// writing history pages into it is how an 8MB file becomes an 80MB one.
const pageCache: Map<string, { head: string; turns: Turn[]; start: number }> = ((globalThis as any).__minamiPageCache ||= new Map());
const PAGE_CACHE_MAX = 24;

// id → file path index, built as a side effect of listSessions()'s directory walk (which already scans
// everything) so getSession()'s hot polling path (every ~2.5s per open chat pane) doesn't have to
// re-scan all project dirs with fs.existsSync just to find a file it already found last time. Bounded
// LRU for the same reason as the meta cache above — otherwise it's one more Map that only ever grows
// for the life of the process, over every distinct session id ever seen.
const idIndex: Map<string, string> = ((globalThis as any).__minamiIdIndex ||= new Map());
const ID_INDEX_MAX = 2000; // tiny entries (id → path string) — generous cap costs almost nothing

export function resolveSessionFile(id: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) return "";
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
  return found;
}

export function getSession(id: string, opts?: { before?: number }): SessionPage {
  const empty: SessionPage = { meta: null, turns: [], start: 0, hasMore: false };
  loadDiskCache();
  loadTurnsDiskCache();
  const found = resolveSessionFile(id);
  if (!found) return empty;
  const st = fs.statSync(found);
  const mtime = st.mtimeMs;
  const size = st.size;
  // Meta (token/cost totals) needs the whole file and would defeat the point of windowing — but the chat
  // panel renders titles from the sessions list, not from here, and listSessions keeps meta warm. So
  // serve meta from cache only (best-effort) and never full-read a huge file just to attach it.
  const metaEntry = cache.get(found);
  if (metaEntry) touchLRU(cache, found, metaEntry, META_CACHE_MAX);
  const meta = metaEntry?.meta ?? null;

  // --- history page: everything strictly BEFORE a byte offset the client already has -----------------
  if (opts?.before !== undefined && opts.before > 0) {
    const head = headFingerprint(found, Math.min(size, HEAD_FINGERPRINT_BYTES));
    const key = `${found}|${opts.before}`;
    const hit = pageCache.get(key);
    if (hit && hit.head === head) {
      touchLRU(pageCache, key, hit, PAGE_CACHE_MAX);
      return { meta, turns: hit.turns, start: hit.start, hasMore: hit.start > 0 };
    }
    const { turns, start } = readTurnsBack(found, Math.min(opts.before, size), WINDOW_MIN_TURNS);
    touchLRU(pageCache, key, { head, turns, start }, PAGE_CACHE_MAX);
    return { meta, turns, start, hasMore: start > 0 };
  }

  // --- live tail ------------------------------------------------------------------------------------
  const tc = turnsCache.get(found);
  // Unchanged (both mtime AND size) — cheap path, no file read at all. No disk write either: this is the
  // path every 2.5s poll takes when nothing changed, and rewriting the cache file on every idle tick
  // would just trade one kind of thrashing for another.
  if (tc && tc.mtime === mtime && tc.size === size) {
    touchTurnsLRU(found, tc);
    return { meta, turns: tc.turns, start: tc.start, hasMore: tc.start > 0 };
  }

  // INCREMENTAL by design, for the same reason summarize() is: an actively streaming session's mtime
  // changes on almost every poll, and re-reading the whole window each time is what made a live pane
  // expensive. Only the bytes appended since the last parse are read and folded onto the existing turns.
  // The head fingerprint is mandatory, not defensive: without it a truncate-and-rewrite that lands on an
  // equal-or-larger size looks exactly like a pure append, and we would fold unrelated bytes onto a stale
  // window forever, with no error and permanently wrong output.
  const headOk = !!tc && (tc.size === 0 || tc.head === headFingerprint(found, Math.min(tc.size, HEAD_FINGERPRINT_BYTES)));
  let entry: TurnsEntry;
  if (tc && tc.size < size && headOk) {
    const turns = tc.turns.slice();
    const toolIndex = rebuildToolIndex(turns);
    const leftoverBytes = tc.byteLeftoverB64 ? Buffer.from(tc.byteLeftoverB64, "base64") : Buffer.alloc(0);
    const newBuf = readNewBytes(found, tc.size, size);
    const combined = leftoverBytes.length ? Buffer.concat([leftoverBytes, newBuf]) : newBuf;
    const { complete, leftover } = splitTrailingIncompleteUtf8(combined);
    const text = tc.lineLeftover + complete.toString("utf8");
    // The held partial line's bytes were already counted in tc.size, so the chunk's true starting offset
    // sits that far back — otherwise every turn in this fold would be labelled with a too-large offset
    // and paging from it would skip the turns in between.
    const chunkStart = tc.size - Buffer.byteLength(tc.lineLeftover, "utf8") - leftoverBytes.length;
    const parts = text.split("\n");
    const lineLeftover = text.endsWith("\n") ? "" : (parts.pop() || "");
    if (text.endsWith("\n")) parts.pop(); // trailing "" left by split()
    parseLines(parts, chunkStart, turns, toolIndex);
    entry = {
      mtime, size, head: headFingerprint(found, Math.min(size, HEAD_FINGERPRINT_BYTES)),
      start: tc.start, turns, lineLeftover,
      byteLeftoverB64: leftover.length ? leftover.toString("base64") : "",
    };
  } else {
    const { turns, start } = readTurnsBack(found, size, WINDOW_MIN_TURNS);
    entry = {
      mtime, size, head: headFingerprint(found, Math.min(size, HEAD_FINGERPRINT_BYTES)),
      start, turns, lineLeftover: "", byteLeftoverB64: "",
    };
  }

  entry = trimWindow(entry, LIVE_WINDOW_TURNS);
  touchTurnsLRU(found, entry);
  turnsCacheDirty = true;
  scheduleTurnsDiskSave(); // throttled — never on the hot path
  return { meta, turns: entry.turns, start: entry.start, hasMore: entry.start > 0 };
}

// Full history, streamed line by line — never bounded, never cached, never on a request path. This is
// what the CLI (bin/transcript.mjs) uses: a 64MB transcript must be readable end-to-end without the
// windowing above and without holding the whole file in memory.
export function readAllTurns(file: string, onTurn: (t: Turn) => void): number {
  const CHUNK = 1 << 20;
  const fd = fs.openSync(file, "r");
  let off = 0, count = 0;
  let lineLeftover = "";
  // Uint8Array, not Buffer: splitTrailingIncompleteUtf8 hands back a subarray whose backing store is
  // ArrayBufferLike, which no longer assigns to Buffer<ArrayBuffer> under this TS lib.
  let byteLeftover: Uint8Array = Buffer.alloc(0);
  const toolIndex = new Map<string, ToolCallRecord>();
  try {
    const size = fs.fstatSync(fd).size;
    while (off < size) {
      const len = Math.min(CHUNK, size - off);
      const buf = Buffer.allocUnsafe(len);
      const read = fs.readSync(fd, buf, 0, len, off);
      off += read;
      const combined = byteLeftover.length ? Buffer.concat([byteLeftover, buf.subarray(0, read)]) : buf.subarray(0, read);
      const { complete, leftover } = splitTrailingIncompleteUtf8(combined);
      byteLeftover = leftover;
      const text = lineLeftover + complete.toString("utf8");
      const parts = text.split("\n");
      lineLeftover = text.endsWith("\n") ? "" : (parts.pop() || "");
      if (text.endsWith("\n")) parts.pop();
      const turns: Turn[] = [];
      parseLines(parts, 0, turns, toolIndex);
      // Emit as we go so the caller can stream to stdout — holding 1813 turns of a 64MB transcript in an
      // array is exactly the memory blow-up this function exists to avoid.
      for (const t of turns) { onTurn(t); count++; }
    }
    if (lineLeftover.trim()) {
      const turns: Turn[] = [];
      parseLines([lineLeftover], 0, turns, toolIndex);
      for (const t of turns) { onTurn(t); count++; }
    }
  } finally { fs.closeSync(fd); }
  return count;
}
