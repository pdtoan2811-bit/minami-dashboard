#!/usr/bin/env node
// Today · research an added to-do (§26). `node bin/today-research.mjs <date> <todo-id>`
//
// Thomas types a to-do the way he thinks it ("voice clones", "fix the pricing copy on ecvision") and the
// page used to keep exactly that: a title with no detail, no folder, no command, nothing for "Do it with
// Minami" to start from. lib/today.ts spawns this, detached, the moment he adds one. One read-only
// `claude -p --model sonnet` looks at the folders, the vault's project notes and the web, and writes
// back what the heartbeat would have: title, detail, why, folder, focus, est_min, cmd, done_when.
//
// Detached on purpose (like the heartbeat's "Run it now"): a deploy restarts the server that spawned it,
// and a research run takes 1–4 min. It writes the day file itself, the same way everyone else does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// Headless and session-less, so the usage board can't see this run in ~/.claude/projects. Its token counts go to the
// same ledger the toolshed's claude.mjs writes (~/.minami/headless-usage.jsonl), which lib/usage-index.ts reads (§16).
function logUsage(result) {
  try {
    const file = process.env.MINAMI_HEADLESS_USAGE || path.join(os.homedir(), ".minami", "headless-usage.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), source: "today-research", cwd: process.cwd(), model: "sonnet",
      turns: result?.num_turns, ms: result?.duration_ms, modelUsage: result?.modelUsage || {} }) + "\n");
  } catch { /* observability only */ }
}

const HOME = os.homedir();
const DIR = process.env.MINAMI_TODAY_DIR || path.join(HOME, ".minami/today");
const VAULT = path.join(HOME, "secondBrain");
const CLAUDE = fs.existsSync("/opt/homebrew/bin/claude") ? "/opt/homebrew/bin/claude" : "claude";
const TIMEOUT_MS = 6 * 60e3;
// The folders a to-do usually lives in. Recent days' to-dos add any others he works in.
const KNOWN = ["~/ecvisionContent", "~/ecvision", "~/tiktok-studio", "~/minami-dashboard", "~/Minami", "~/secondBrain"];

const [date, id] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^[0-9a-f]{8}$/.test(id || "")) { console.error("usage: today-research.mjs <date> <todo-id>"); process.exit(2); }
const file = path.join(DIR, `${date}.json`);
const expand = (f) => String(f || "").replace(/^~(?=\/|$)/, HOME);
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const now = () => new Date().toISOString();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Re-read, change one to-do, save atomically. Never saves a copy read before the model call: the page
 *  and today-sync write this file all day (the heartbeat's lost-ticks bug, §26 hardening). */
function update(fn) {
  const day = read();
  const t = day.todos.find((x) => x.id === id);
  if (!t) return false; // dropped while we worked: nothing to write
  fn(t, day);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(day, null, 1));
  fs.renameSync(tmp, file);
  return true;
}

function folders(day) {
  const seen = new Set(KNOWN);
  for (const d of fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-4)) {
    try { for (const t of JSON.parse(fs.readFileSync(path.join(DIR, d), "utf8")).todos || []) if (typeof t.folder === "string" && t.folder.startsWith("~/")) seen.add(t.folder); } catch {}
  }
  for (const t of day.todos) if (typeof t.folder === "string" && t.folder.startsWith("~/")) seen.add(t.folder);
  return [...seen].filter((f) => fs.existsSync(expand(f)));
}

function prompt(day, t, dirs) {
  const others = day.todos.filter((x) => x.id !== t.id).map((x) => `- ${x.title || x.text.split("\n")[0]}${x.folder ? ` (${x.folder})` : ""}${x.done ? " ✓" : ""}`).join("\n") || "—";
  return `Thomas just added this to-do to his Today page, typed quickly:

"${t.asked}"
${(t.comments ?? []).length ? `\nHis comments on it since:\n${t.comments.map((c) => `- ${c.text}`).join("\n")}\n` : ""}
Work out what he means and write it up as a to-do Minami can pick up cold. Research first, read-only:
- the vault's project notes (~/secondBrain/10-19 Projects/*.md) for the project it belongs to: its phase, next_move, blocked_on;
- the folder it belongs to (README, CLAUDE.md, recent files, docs) to find the real file names, scripts, slugs and commands;
- the web only if the to-do is about an outside tool or service (e.g. which voice-clone service, an API's limits).
Don't invent file names, slugs or commands: name only what you found. If something is unknown, say what to check.

Today (${day.date}) — headline: ${day.headline || "—"}
Focus: ${day.focus.map((f) => `${f.name} — ${f.status}`).join(" · ") || "—"}
His other to-dos today:
${others}

Folders he works in: ${dirs.join(", ")}

Answer with ONLY this JSON, no prose around it:
{"title": "≤60 chars: a verb and the thing", "text": "the concrete detail he'd want on his phone: what exactly to do, the files/slugs/ids you found, the steps (short lines), any caveat", "why": "one short reason it matters today, or omit", "focus": "seo|video|other", "folder": "one of the folders above, where the work happens", "est_min": 30, "cmd": "an exact command to run if there is one, else omit", "done_when": [{"kind":"commit","folder":"~/repo","grep":"words"}]}

done_when: only if the finished outcome can be seen without judgement. Kinds: {"kind":"live","what":"blog","path":"<article slug>"} · {"kind":"gate","draft":"<drafts/ dir>","status":"proposed"} · {"kind":"file","path":"~/…","since_today":true} · {"kind":"commit","folder":"~/repo","grep":"<words>"} · {"kind":"url","url":"https://…","contains":"text"}. Otherwise omit it.
Keep his intent: if he wrote it in Vietnamese, the title may stay in his words. Never widen the task.`;
}

function runClaude(text, dirs) {
  return new Promise((resolve, reject) => {
    // Quarantined like the toolshed's claude.mjs — no settings (so no hooks: a research turn in the thread
    // ledger would read to today-sync's judge as work done), no MCP, no saved session (it would show up on
    // the board as a chat) — but with the read tools research needs. --tools is what restricts the set;
    // --allowedTools approves them, since with no settings nothing else would.
    const tools = "WebSearch,WebFetch,Read,Glob,Grep";
    const p = spawn(CLAUDE, ["-p", "--model", "sonnet", "--output-format", "json", "--setting-sources", "",
      "--strict-mcp-config", "--no-session-persistence", "--tools", tools, "--allowedTools", tools,
      "--add-dir", ...dirs.map(expand)], { cwd: VAULT, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGTERM"); reject(new Error("timed out after 6 min")); }, TIMEOUT_MS);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        logUsage(j);
        if (j.is_error) throw new Error(j.result || "claude error");
        resolve({ result: String(j.result || ""), usd: j.total_cost_usd ?? null });
      } catch (e) { reject(new Error(`claude exit ${code}: ${clip((err || out || String(e)).trim(), 240)}`)); }
    });
    p.stdin.end(text);
  });
}

function parse(result) {
  const a = result.indexOf("{"), b = result.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON in the answer");
  return JSON.parse(result.slice(a, b + 1));
}

const str = (x, n) => (typeof x === "string" && x.trim() ? clip(x.trim(), n) : undefined);

async function main() {
  const day = read();
  const t = day.todos.find((x) => x.id === id);
  if (!t) return;
  t.asked ||= t.text; // the words he typed; kept so a retry researches those, not our rewrite
  const dirs = folders(day);
  const { result, usd } = await runClaude(prompt(day, t, dirs), dirs);
  const r = parse(result);
  let checks;
  try { checks = (await import(path.join(VAULT, "bin/today-checks.mjs"))).cleanChecks(r.done_when); } catch { checks = undefined; }
  const folder = str(r.folder, 120);
  update((t, day) => {
    // He may have edited, ticked or handed it off meanwhile. Fill what research found; never override a
    // choice he made since (a tick, a hand-off). The title/detail are ours to write: he only typed one line.
    t.asked ||= t.text;
    t.title = str(r.title, 60) || t.title;
    t.text = str(r.text, 2000) || t.text;
    if (str(r.why, 240)) t.why = str(r.why, 240);
    if (["seo", "video", "other"].includes(r.focus) && (!t.focus || t.focus === "other")) t.focus = r.focus;
    if (folder && folder.startsWith("~/") && fs.existsSync(expand(folder))) t.folder = folder;
    if (Number.isFinite(r.est_min) && r.est_min > 0) t.est_min = Math.min(480, Math.round(r.est_min));
    if (str(r.cmd, 300)) t.cmd = str(r.cmd, 300);
    if (checks && !t.done) t.done_when = checks;
    t.research = { state: "done", at: now(), usd };
    day.log.push({ at: now(), kind: "todo", text: `Researched: ${t.title}${usd ? ` ($${usd.toFixed(2)})` : ""}` });
  });
}

main().then(() => process.exit(0)).catch((e) => {
  try { update((t) => { t.research = { state: "failed", at: now(), error: clip(String(e?.message || e), 240) }; }); } catch {}
  console.error(e);
  process.exit(1);
});
