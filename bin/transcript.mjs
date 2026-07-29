#!/usr/bin/env node
// Read a Claude Code transcript END TO END, from the terminal, with no caps and no server.
//
// WHY THIS EXISTS SEPARATELY FROM THE DASHBOARD
// lib/claude-sessions.ts reads transcripts in WINDOWS on purpose: it serves a UI that polls every 2.5s,
// so it must never full-read a 64MB file on a request path. That's the right trade for a pane and the
// wrong one for "show me the whole conversation". This script is the other half — a single forward pass,
// streamed, bounded memory, no cache, no truncation. The two parsers look similar and must NOT be
// "unified": collapsing them means either the dashboard full-reads on every poll, or the CLI inherits
// the window and silently stops being able to show you everything. Different jobs, different code.
//
// Works with the dashboard down, which is exactly when you need it.
//
//   node bin/transcript.mjs list [filter]           sessions on disk, newest first
//   node bin/transcript.mjs show <id|file> [opts]   the whole conversation
//
//   --format text|md|json   text (default, human) · md (shareable) · json (JSONL, one turn per line)
//   --tools                 include tool calls (default: text only)
//   --tail N | --head N     last / first N turns
//   --since YYYY-MM-DD      only turns at or after this date
//   --grep PATTERN          only turns matching (case-insensitive)
//   --out FILE              write to a file instead of stdout
//
// JSONL out is the token-slayer / jq surface:
//   node bin/transcript.mjs show <id> --format json | jq -r 'select(.role=="user") | .text'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const CHUNK = 1 << 20;

// --- the parser -------------------------------------------------------------------------------------
// Deliberately a single forward pass. A transcript is JSONL, one row per line, and a turn's tool_result
// arrives on a LATER line than the tool_use it belongs to — so tool calls are held in a map by id until
// their result shows up, exactly as the dashboard does.
function* streamTurns(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    let off = 0, lineLeftover = "", byteLeftover = Buffer.alloc(0);
    const pending = new Map();
    while (off < size) {
      const len = Math.min(CHUNK, size - off);
      const buf = Buffer.allocUnsafe(len);
      const read = fs.readSync(fd, buf, 0, len, off);
      off += read;
      const combined = byteLeftover.length ? Buffer.concat([byteLeftover, buf.subarray(0, read)]) : buf.subarray(0, read);
      // Never decode a partial UTF-8 sequence at a chunk boundary — it would corrupt the character and,
      // worse, any JSON string containing it.
      const cut = trailingIncomplete(combined);
      byteLeftover = combined.subarray(combined.length - cut);
      const text = lineLeftover + combined.subarray(0, combined.length - cut).toString("utf8");
      const parts = text.split("\n");
      lineLeftover = text.endsWith("\n") ? "" : (parts.pop() || "");
      if (text.endsWith("\n")) parts.pop();
      for (const line of parts) { const t = foldLine(line, pending); if (t) yield t; }
    }
    if (lineLeftover.trim()) { const t = foldLine(lineLeftover, pending); if (t) yield t; }
  } finally { fs.closeSync(fd); }
}

function trailingIncomplete(buf) {
  if (!buf.length) return 0;
  let i = buf.length - 1, cont = 0;
  while (i >= 0 && cont < 3 && (buf[i] & 0b11000000) === 0b10000000) { i--; cont++; }
  if (i < 0) return buf.length;
  const lead = buf[i];
  const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return seqLen > buf.length - i ? buf.length - i : 0;
}

function foldLine(line, pending) {
  if (!line.trim()) return null;
  let r;
  try { r = JSON.parse(line); } catch { return null; }
  if (r.type !== "user" && r.type !== "assistant") return null;
  const c = r.message?.content;
  let text = "";
  const tools = [];
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b?.type === "text") text += (text ? "\n" : "") + b.text;
      else if (b?.type === "thinking" && b.thinking) text += (text ? "\n" : "") + b.thinking;
      else if (b?.type === "tool_use") { const rec = { name: b.name, input: b.input }; tools.push(rec); if (b.id) pending.set(b.id, rec); }
      else if (b?.type === "tool_result" && b.tool_use_id) {
        const rec = pending.get(b.tool_use_id);
        if (rec) { rec.ok = !b.is_error; rec.output = resultText(b.content); pending.delete(b.tool_use_id); }
      }
    }
  }
  if (!text.trim() && !tools.length) return null;
  return { role: r.type, text: text.trim(), tools, ts: r.timestamp || "", model: r.message?.model, cwd: r.cwd };
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
  }
  return "";
}

// --- session discovery ------------------------------------------------------------------------------
function allSessions() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        out.push({ id: f.slice(0, -6), file: p, project: d.replace(/^-Users-[^-]+-/, ""), size: st.size, mtime: st.mtimeMs });
      } catch { /* vanished mid-scan */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function resolve(idOrPath) {
  if (idOrPath.includes("/") && fs.existsSync(idOrPath)) return idOrPath;
  const all = allSessions();
  const exact = all.find((s) => s.id === idOrPath);
  if (exact) return exact.file;
  const partial = all.filter((s) => s.id.startsWith(idOrPath));
  if (partial.length === 1) return partial[0].file;
  if (partial.length > 1) {
    process.stderr.write(`ambiguous id "${idOrPath}" — ${partial.length} matches:\n`);
    for (const s of partial.slice(0, 10)) process.stderr.write(`  ${s.id}  ${s.project}\n`);
    process.exit(2);
  }
  process.stderr.write(`no session matching "${idOrPath}". Try: node bin/transcript.mjs list\n`);
  process.exit(2);
}

// --- formatting -------------------------------------------------------------------------------------
function human(n) {
  return n > 1e9 ? (n / 1e9).toFixed(1) + "G" : n > 1e6 ? (n / 1e6).toFixed(1) + "M" : n > 1e3 ? Math.round(n / 1e3) + "K" : String(n);
}

function fmtText(t, i, showTools) {
  const who = t.role === "user" ? "YOU" : "CLAUDE";
  const when = t.ts ? new Date(t.ts).toLocaleString() : "";
  let s = `\n${"─".repeat(72)}\n[${i}] ${who}${when ? "  ·  " + when : ""}${t.model ? "  ·  " + t.model : ""}\n\n`;
  if (t.text) s += t.text + "\n";
  if (showTools) for (const tc of t.tools) {
    const arg = tc.input?.file_path || tc.input?.command || tc.input?.pattern || tc.input?.path || "";
    s += `    → ${tc.name}${arg ? " " + String(arg).slice(0, 120) : ""}${tc.ok === false ? "  [FAILED]" : ""}\n`;
  }
  return s;
}

function fmtMd(t, i, showTools) {
  const who = t.role === "user" ? "You" : "Claude";
  const when = t.ts ? new Date(t.ts).toISOString().slice(0, 19).replace("T", " ") : "";
  let s = `\n### ${i}. ${who}${when ? ` — ${when}` : ""}\n\n`;
  if (t.text) s += t.text + "\n";
  if (showTools && t.tools.length) {
    s += "\n";
    for (const tc of t.tools) {
      const arg = tc.input?.file_path || tc.input?.command || tc.input?.pattern || tc.input?.path || "";
      s += `- \`${tc.name}\`${arg ? " " + String(arg).slice(0, 120) : ""}${tc.ok === false ? " **failed**" : ""}\n`;
    }
  }
  return s;
}

// --- main -------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
function flag(name, def) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
}
const has = (name) => argv.includes("--" + name);

if (!cmd || cmd === "help" || has("help")) {
  process.stdout.write(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
  process.exit(0);
}

if (cmd === "list") {
  const filter = (argv[1] && !argv[1].startsWith("--") ? argv[1] : "").toLowerCase();
  const rows = allSessions().filter((s) => !filter || s.project.toLowerCase().includes(filter) || s.id.startsWith(filter));
  const n = Number(flag("limit", "40"));
  process.stdout.write(`${rows.length} session(s)${filter ? ` matching "${filter}"` : ""} — showing ${Math.min(n, rows.length)}\n\n`);
  for (const s of rows.slice(0, n)) {
    process.stdout.write(`${s.id}  ${human(s.size).padStart(6)}  ${new Date(s.mtime).toLocaleString().padEnd(22)}  ${s.project}\n`);
  }
  process.exit(0);
}

if (cmd !== "show") {
  process.stderr.write(`unknown command "${cmd}" — try: list, show, help\n`);
  process.exit(2);
}

const file = resolve(argv[1] || "");
const format = flag("format", "text");
const showTools = has("tools");
const tail = Number(flag("tail", "0"));
const head = Number(flag("head", "0"));
const since = flag("since", "");
const grep = flag("grep", "");
const outPath = flag("out", "");
const sinceTs = since ? Date.parse(since) : 0;
const grepRe = grep ? new RegExp(grep, "i") : null;

const out = outPath ? fs.createWriteStream(outPath) : process.stdout;
const write = (s) => { try { out.write(s); } catch { /* EPIPE from `| head` — expected */ } };
// EPIPE is the normal way a `| head` ends this process; crashing on it would be noise, not an error.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); });

const keep = [];
let i = 0, shown = 0;
for (const t of streamTurns(file)) {
  i++;
  if (sinceTs && (!t.ts || Date.parse(t.ts) < sinceTs)) continue;
  if (grepRe && !grepRe.test(t.text)) continue;
  if (head && shown >= head) break;
  if (tail) {
    // Only --tail needs to hold turns back; everything else streams straight out, so a 64MB transcript
    // never lands in memory all at once.
    keep.push([i, t]);
    if (keep.length > tail) keep.shift();
    continue;
  }
  shown++;
  write(format === "json" ? JSON.stringify({ i, ...t }) + "\n" : format === "md" ? fmtMd(t, i, showTools) : fmtText(t, i, showTools));
}
if (tail) for (const [n, t] of keep) {
  write(format === "json" ? JSON.stringify({ i: n, ...t }) + "\n" : format === "md" ? fmtMd(t, n, showTools) : fmtText(t, n, showTools));
}
if (format !== "json") write(`\n${"─".repeat(72)}\n${i} turn(s) total · ${file}\n`);
if (outPath) { out.end(); process.stderr.write(`wrote ${outPath}\n`); }
