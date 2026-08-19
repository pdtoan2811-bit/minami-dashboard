#!/usr/bin/env node
// SETUP AND DOCTOR for the meeting bot, run on the machine that actually hosts it.
//
// This exists because every serious outage in this project so far has been a CONFIG problem wearing a
// code problem's clothes, and every one of them was silent:
//
//   · CANVAS_INGEST_TOKEN was declared TWICE in .env.local — once empty on line 13, once real on line
//     35. dotenv keeps the first. The file looked correct, the server booted clean, and the ingest
//     endpoint sat wide open on a public tunnel. Confirmed by an unauthenticated POST being accepted.
//   · CANVAS_STT_MODEL was pinned in .env.local, so changing the default in code did nothing and two
//     meetings ran on a model nobody had chosen.
//   · Two different judge models were declared in two files; they agreed only when the env var was set.
//
// None of those are visible by reading the file, which is exactly why this reads it the way the app
// does — first declaration wins, empty counts as set — and then CALLS each service to prove the
// credential works rather than that it is merely present.
//
//   node bin/minami-setup.mjs           interactive: fill what is missing, generate what can be generated
//   node bin/minami-setup.mjs --check   read-only doctor, changes nothing, exits non-zero if not ready
//
// Secrets are never printed. Values are shown masked, because the question is always "is it the right
// one" and never "what is it".

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ENV_PATH = new URL("../.env.local", import.meta.url).pathname;
const CHECK_ONLY = process.argv.includes("--check");

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const mask = (v) => (!v ? "" : v.length <= 8 ? "•".repeat(v.length) : `${v.slice(0, 4)}…${v.slice(-4)} (${v.length})`);

/** Parse .env.local THE WAY DOTENV DOES: first declaration wins, and an empty value still counts as
 *  declared. Reading it any other way is how the duplicate-token hole stayed invisible. */
function readEnv() {
  if (!existsSync(ENV_PATH)) return { vals: {}, dupes: [], lines: [] };
  const lines = readFileSync(ENV_PATH, "utf8").split("\n");
  const vals = {};
  const seen = new Map();
  const dupes = [];
  lines.forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith("#") || !line.includes("=")) return;
    const k = line.slice(0, line.indexOf("=")).trim();
    const v = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    if (seen.has(k)) { dupes.push({ key: k, first: seen.get(k) + 1, dup: i + 1 }); return; }
    seen.set(k, i);
    vals[k] = v;
  });
  return { vals, dupes, lines };
}

function writeEnv(updates) {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : [];
  if (existsSync(ENV_PATH)) copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);
  const out = [];
  const applied = new Set();
  for (const line of lines) {
    const k = line.includes("=") && !line.trimStart().startsWith("#") ? line.slice(0, line.indexOf("=")).trim() : null;
    if (k && k in updates && !applied.has(k)) { out.push(`${k}=${updates[k]}`); applied.add(k); continue; }
    if (k && applied.has(k)) continue; // drop the duplicate rather than leave the trap in place
    out.push(line);
  }
  for (const [k, v] of Object.entries(updates)) if (!applied.has(k)) out.push(`${k}=${v}`);
  writeFileSync(ENV_PATH, out.join("\n").replace(/\n{3,}$/, "\n"));
}

const timeout = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };

/** Every probe CALLS the service. "Present" is not "works" — a rotated Recall key and a typo'd Blaze
 *  token both read as a perfectly good string. */
const CHECKS = [
  {
    key: "BLAZE_API_KEY",
    what: "Blaze — an optional ear, selectable from the dock (not the default any more)",
    required: false,
    async probe(v, env) {
      const base = env.BLAZE_BASE_URL || "https://api.blaze.vn/v1";
      const res = await fetch(`${base}/stt-history?limit=1`, {
        headers: { Authorization: `Bearer ${v}` }, signal: timeout(15000),
      });
      return res.ok ? { ok: true, note: "authenticated" } : { ok: false, note: `HTTP ${res.status}` };
    },
  },
  {
    key: "OPENROUTER_API_KEY",
    what: "OpenRouter — the judge that turns speech into cards",
    required: true,
    async probe(v) {
      const res = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${v}` }, signal: timeout(15000),
      });
      if (!res.ok) return { ok: false, note: `HTTP ${res.status}` };
      const d = await res.json().catch(() => null);
      const limit = d?.data?.limit_remaining;
      return { ok: true, note: limit == null ? "authenticated" : `$${Number(limit).toFixed(2)} remaining` };
    },
  },
  {
    key: "RECALL_API_KEY",
    what: "Recall.ai — puts the bot in the meeting and streams its audio",
    required: true,
    async probe(v, env) {
      const region = env.RECALL_REGION || "ap-northeast-1";
      const res = await fetch(`https://${region}.recall.ai/api/v1/bot?limit=1`, {
        headers: { Authorization: `Token ${v}` }, signal: timeout(15000),
      });
      return res.ok ? { ok: true, note: `authenticated (${region})` } : { ok: false, note: `HTTP ${res.status}` };
    },
  },
  {
    key: "CANVAS_INGEST_TOKEN",
    what: "guards /api/canvas/ingest — audio in, spend out",
    required: true,
    generate: true,
    note: "generated locally; must match on the app and the receiver",
  },
  {
    key: "RECALL_RECEIVER_TOKEN",
    what: "guards the audio websocket Recall dials into",
    required: true,
    generate: true,
    note: "generated locally; travels in the ?token= of the receiver URL",
  },
];

const INFO = [
  ["CANVAS_STT_MODEL", "omni:google/gemini-3-flash-preview", "which ear is listening — lib/canvas-modes.ts is the one declaration"],
  ["CANVAS_STT_LANGUAGE", "vi", "pinned language — auto-detect made chirp-3 TRANSLATE instead of transcribe"],
  ["CANVAS_DERIVE_MODEL", "", "judge override; blank uses the single default in lib/canvas-modes.ts"],
  ["CANVAS_BUDGET_USD", "50", "monthly ceiling — the omni ear bills on OpenRouter and IS counted"],
];

async function main() {
  const { vals, dupes } = readEnv();
  console.log(`\n  Minami setup ${dim(CHECK_ONLY ? "(--check, read-only)" : "(interactive)")}`);
  console.log(`  ${dim(ENV_PATH)}\n`);

  // ── duplicates first, because a duplicate silently DISABLES the real value below it ──────────
  if (dupes.length) {
    console.log(`  ${r("✗ duplicate keys")} — dotenv keeps the FIRST, so the later one never loads:`);
    for (const d of dupes) console.log(`      ${d.key}  line ${d.first} wins, line ${d.dup} ignored`);
    console.log(`    ${dim(CHECK_ONLY ? "run without --check to remove the duplicates" : "these will be removed on write")}\n`);
  }

  const missing = [];
  const broken = [];

  for (const c of CHECKS) {
    const v = vals[c.key] || "";
    if (!v) {
      console.log(`  ${r("✗")} ${c.key}  ${dim("not set")}`);
      console.log(`      ${c.what}`);
      missing.push(c);
      continue;
    }
    let verdict = { ok: true, note: c.note || "set" };
    if (c.probe) {
      try { verdict = await c.probe(v, vals); }
      catch (e) { verdict = { ok: false, note: e.name === "AbortError" ? "timed out" : String(e.message).slice(0, 60) }; }
    }
    console.log(`  ${verdict.ok ? g("✓") : r("✗")} ${c.key}  ${dim(mask(v))}  ${verdict.ok ? dim(verdict.note) : r(verdict.note)}`);
    if (!verdict.ok) broken.push(c.key);
  }

  console.log("");
  for (const [k, dflt, why] of INFO) {
    const v = vals[k] ?? "";
    const shown = v || (dflt ? `${dflt} ${dim("(default)")}` : dim("(unset)"));
    console.log(`  ${dim("·")} ${k} = ${shown}`);
    console.log(`      ${dim(why)}`);
  }

  // ── local services ───────────────────────────────────────────────────────────────────────────
  console.log("");
  let serviceProblem = false;
  const port = vals.PORT || "3010";
  for (const [label, url, hint] of [
    ["app", `http://127.0.0.1:${port}/`, `bin/serve.sh start`],
    ["ingest", `http://127.0.0.1:${port}/api/canvas/ingest`, `restart the app to load .env.local`],
  ]) {
    try {
      const res = await fetch(url, {
        method: label === "ingest" ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        body: label === "ingest" ? "{}" : undefined,
        signal: timeout(8000),
      });
      // 401 is the CORRECT answer for ingest without a token. 503 means the app booted without one.
      const good = label === "ingest" ? res.status === 401 : res.ok;
      const meaning = label === "ingest" && res.status === 503 ? "token not loaded — restart the app" : `HTTP ${res.status}`;
      console.log(`  ${good ? g("✓") : y("!")} ${label.padEnd(7)} ${dim(meaning)}`);
      if (!good) { serviceProblem = true; console.log(`      ${dim(hint)}`); }
    } catch {
      serviceProblem = true;
      console.log(`  ${y("!")} ${label.padEnd(7)} ${dim("not reachable")}`);
      console.log(`      ${dim(hint)}`);
    }
  }

  if (CHECK_ONLY) {
    // Readiness MUST include the running services. An earlier cut reported "ready" while ingest was
    // answering 503 — credentials perfect, pipeline dead. That is the precise illusion this exists
    // to break, so a service problem is a failure and not a footnote.
    const ready = !missing.length && !broken.length && !dupes.length && !serviceProblem;
    console.log(`\n  ${ready ? g("ready") : r("not ready")}\n`);
    process.exit(ready ? 0 : 1);
  }

  if (!missing.length && !dupes.length) {
    console.log(`\n  ${g("nothing to fill in")}${broken.length ? y(" — but check the failures above") : ""}\n`);
    return;
  }

  // ── fill the gaps ────────────────────────────────────────────────────────────────────────────
  const rl = createInterface({ input: stdin, output: stdout });
  const updates = {};
  for (const c of missing) {
    console.log(`\n  ${c.key} — ${c.what}`);
    if (c.generate) {
      const a = (await rl.question(`    generate one now? [Y/n] `)).trim().toLowerCase();
      if (a === "" || a === "y") { updates[c.key] = randomBytes(24).toString("hex"); console.log(`    ${g("generated")}`); continue; }
    }
    const v = (await rl.question(`    paste the value (blank to skip): `)).trim();
    if (v) updates[c.key] = v;
  }
  rl.close();

  if (!Object.keys(updates).length && !dupes.length) { console.log(`\n  ${dim("nothing changed")}\n`); return; }
  writeEnv(updates);
  console.log(`\n  ${g("written")} ${dim(`(backup at .env.local.bak — it holds secrets, delete it when happy)`)}`);
  console.log(`  ${y("restart the app")} so it picks the new values up: ${dim("bin/serve.sh restart")}\n`);
}

main().catch((e) => { console.error(`\n  ${r("setup failed")}: ${e.message}\n`); process.exit(1); });
