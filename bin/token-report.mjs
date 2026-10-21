#!/usr/bin/env node
// Where this box's Claude usage goes — `npm run tokens [-- --days 7]`.
//
// Reads every transcript under ~/.claude/projects touched in the window and prices each API call at
// list rates. The dollars are a YARDSTICK, not a bill: the box runs on a subscription, and the weekly
// limit doesn't weight models exactly like the rate card. The shares are the durable part — they are
// what the 2026-10-21 token plan (docs/knowledge/16-token-economics.md §16) is measured against.
//
// Blind spot, on purpose: headless calls made through the toolshed's claude.mjs run with
// --no-session-persistence and leave no transcript. Those are the Haiku/Sonnet automations.
//
// Writes ~/.minami/token-report.json (one entry per run, newest last) so weeks can be compared.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import readline from "node:readline";

const DAYS = Number(process.argv[process.argv.indexOf("--days") + 1]) || 7;
const ROOT = path.join(os.homedir(), ".claude/projects");
const OUT = path.join(os.homedir(), ".minami/token-report.json");
const since = Date.now() - DAYS * 864e5;

// $/MTok: input, output, cache read, 5-min cache write. platform.claude.com pricing, checked 2026-10-21.
// Haiku 5.5 is priced at its ≤100k-prompt tier; its >100k tier is 5× that.
function price(model) {
  if (/fable/.test(model)) return [10, 50, 0.25, 12.5];
  if (/opus-5-5/.test(model)) return [4, 20, 0.2, 5];
  if (/opus/.test(model)) return [5, 25, 0.5, 6.25];
  if (/sonnet-5/.test(model)) return [2, 10, /5-5/.test(model) ? 0.1 : 0.2, 2.5];
  if (/sonnet/.test(model)) return [3, 15, 0.3, 3.75];
  if (/haiku-5-5/.test(model)) return [0.1, 0.5, 0.01, 0.125];
  if (/haiku/.test(model)) return [1, 5, 0.1, 1.25];
  return [4, 20, 0.2, 5];
}
const fam = (m) => (m.match(/fable|opus|sonnet|haiku/) || ["other"])[0];

function walk(d) {
  let out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith(".jsonl") && fs.statSync(p).mtimeMs >= since) out.push(p);
  }
  return out;
}

const bucket = {}; const seen = new Set(); const sessions = {}; const subModels = {};
const add = (k, c) => { const b = bucket[k] ??= { usd: 0, calls: 0 }; b.usd += c; b.calls++; };
let total = 0;

for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f);
  const proj = rel.split(path.sep)[0].replace(/^-Users-[^-]+-?/, "").replace(/--minami-worktrees-.*/, "") || "~";
  const sub = rel.includes(`${path.sep}subagents${path.sep}`);
  for await (const line of readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity })) {
    if (!line.includes('"usage"') && !line.includes('"Agent"')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const m = j.message; if (j.type !== "assistant" || !m?.usage || m.model === "<synthetic>") continue;
    if (!sub) for (const c of m.content || []) if (c.type === "tool_use" && c.name === "Agent") {
      const k = c.input?.model || "default"; subModels[k] = (subModels[k] || 0) + 1;
    }
    const ts = Date.parse(j.timestamp); if (!(ts >= since)) continue;
    const key = (m.id || "") + (j.requestId || ""); if (seen.has(key)) continue; seen.add(key);
    const u = m.usage, p = price(m.model || "");
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const c = ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_read_input_tokens || 0) * p[2] + (u.cache_creation_input_tokens || 0) * p[3]) / 1e6;
    total += c;
    add(`model ${m.model}`, c);
    add(`where ${fam(m.model || "")} ${sub ? "subagent" : "main"}`, c);
    add(`project ${proj}`, c);
    add(`context ${ctx < 100e3 ? "a <100k" : ctx < 200e3 ? "b 100-200k" : ctx < 400e3 ? "c 200-400k" : "d 400k+"}`, c);
    const s = sessions[j.sessionId] ??= { proj, usd: 0 }; s.usd += c;
  }
}

const pct = (v) => `${((100 * v) / (total || 1)).toFixed(1).padStart(5)}%`;
console.log(`Last ${DAYS} days — $${total.toFixed(0)} at list prices (a yardstick; the box is on a subscription)\n`);
for (const group of ["where", "model", "context", "project"]) {
  const rows = Object.entries(bucket).filter(([k]) => k.startsWith(group + " "))
    .sort((a, b) => (group === "context" ? a[0].localeCompare(b[0]) : b[1].usd - a[1].usd)).slice(0, 10);
  console.log(group.toUpperCase());
  for (const [k, v] of rows) console.log(`  ${k.slice(group.length + 1).replace(/^[a-d] /, "").padEnd(40)} $${v.usd.toFixed(0).padStart(6)} ${pct(v.usd)}  ${v.calls} calls`);
  console.log("");
}
const top = Object.values(sessions).sort((a, b) => b.usd - a.usd);
const top5 = top.slice(0, 5).reduce((a, s) => a + s.usd, 0);
console.log(`SESSIONS  ${top.length} · top 5 = ${pct(top5).trim()} of the window`);
console.log(`SUBAGENTS spawned by model param: ${Object.entries(subModels).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);

let history = [];
try { history = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { /* first run */ }
history.push({ at: new Date().toISOString(), days: DAYS, usd: Math.round(total), buckets: Object.fromEntries(Object.entries(bucket).map(([k, v]) => [k, Math.round(v.usd)])), subModels, top5Share: total ? +(top5 / total).toFixed(3) : 0 });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(history.slice(-52), null, 1));
const prev = history.filter((h) => h.days === DAYS).slice(-2, -1)[0];
if (prev) console.log(`\nvs ${prev.at.slice(0, 10)}: $${prev.usd} → $${Math.round(total)} (${(((total - prev.usd) / (prev.usd || 1)) * 100).toFixed(0)}%)`);
