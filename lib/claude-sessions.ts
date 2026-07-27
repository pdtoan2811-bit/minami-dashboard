/* eslint-disable @typescript-eslint/no-explicit-any */
// Server-only: read Claude Code session transcripts (~/.claude/projects/<enc-cwd>/<id>.jsonl) and
// summarize them for the Bento mirror. Zero deps — Phase 1 observes real terminal/CLI sessions
// read-only. (Driving sessions = Phase 2 via @anthropic-ai/claude-agent-sdk.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-fable-5": { in: 10, out: 50 },
};
function priceFor(model?: string) {
  const k = model ? Object.keys(PRICES).find((x) => model.includes(x)) : undefined;
  return k ? PRICES[k] : { in: 5, out: 25 };
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
  lastActivity: number;
  active: boolean;
};

type Row = { type?: string; message?: any; cwd?: string; gitBranch?: string; timestamp?: string; customTitle?: string; lastPrompt?: string };

const cache = new Map<string, { mtime: number; meta: SessionMeta }>();

function summarize(file: string, id: string): SessionMeta {
  let title = "", lastPrompt = "", model = "", cwd = "", gitBranch = "", firstUser = "";
  let tin = 0, tout = 0, cost = 0, messages = 0, tools = 0, lastTs = 0;
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
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
    } else if (r.type === "assistant") {
      messages++;
      const m = r.message || {};
      if (m.model) model = m.model;
      const u = m.usage;
      if (u) {
        tin += u.input_tokens || 0;
        tout += u.output_tokens || 0;
        const p = priceFor(m.model);
        cost += ((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1) / 1e6 * p.in + (u.output_tokens || 0) / 1e6 * p.out;
      }
      for (const b of m.content || []) if (b?.type === "tool_use") tools++;
    }
  }
  const project = cwd ? cwd.split("/").filter(Boolean).pop() || cwd : (path.basename(path.dirname(file)).replace(/^-/, "").split("-").pop() || "session");
  const lastActivity = Math.max(lastTs, fs.statSync(file).mtimeMs);
  const derived = title || cleanTitle(lastPrompt) || cleanTitle(firstUser) || project;
  return {
    id, project, cwd, gitBranch,
    title: derived.slice(0, 80),
    lastPrompt: (cleanTitle(lastPrompt) || cleanTitle(firstUser)).slice(0, 140),
    model, tier: tierOf(model),
    tokensIn: tin, tokensOut: tout, cost, messages, tools,
    lastActivity, active: Date.now() - lastActivity < 120000,
  };
}

export function listSessions(): SessionMeta[] {
  let dirs: string[];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return []; }
  const out: SessionMeta[] = [];
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d);
    let files: string[];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const mtime = fs.statSync(file).mtimeMs;
        const c = cache.get(file);
        if (c && c.mtime === mtime) { out.push(c.meta); continue; }
        const meta = summarize(file, f.replace(/\.jsonl$/, ""));
        if (meta.messages === 0) continue;
        cache.set(file, { mtime, meta });
        out.push(meta);
      } catch { /* skip unreadable */ }
    }
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 60);
}

export type Turn = { role: "user" | "assistant"; text: string; tools: { name: string; input: any }[]; ts: number; model?: string };

export function getSession(id: string): { meta: SessionMeta | null; turns: Turn[] } {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) return { meta: null, turns: [] };
  let found = "";
  try {
    for (const d of fs.readdirSync(PROJECTS)) {
      const file = path.join(PROJECTS, d, id + ".jsonl");
      if (fs.existsSync(file)) { found = file; break; }
    }
  } catch { /* none */ }
  if (!found) return { meta: null, turns: [] };
  const meta = summarize(found, id);
  const turns: Turn[] = [];
  for (const line of fs.readFileSync(found, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r: Row;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== "user" && r.type !== "assistant") continue;
    const c = r.message?.content;
    let text = "";
    const toolz: { name: string; input: any }[] = [];
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === "text") text += (text ? "\n" : "") + b.text;
        else if (b?.type === "tool_use") toolz.push({ name: b.name, input: b.input });
      }
    }
    if (text.trim() || toolz.length) {
      turns.push({ role: r.type, text: text.trim(), tools: toolz, ts: Date.parse(r.timestamp || "") || 0, model: r.message?.model });
    }
  }
  return { meta, turns: turns.slice(-120) };
}
