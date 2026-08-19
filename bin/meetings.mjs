#!/usr/bin/env node
// THE MEETING SHELF — list what is archived, and throw out what was never a meeting.
//
//   node bin/meetings.mjs              list everything, newest first
//   node bin/meetings.mjs --junk       show only what would be pruned, delete nothing
//   node bin/meetings.mjs --prune      delete the junk (asks first)
//
// The archive fills with FAILED calls, not with meetings worth keeping. Every launch that joined and
// heard nothing — a wrong token, a dry-run receiver, a bot in a waiting room nobody admitted — still
// writes a complete folder with notes.md, canvas.json and transcript.md. They are indistinguishable
// from real meetings in a directory listing, so the real ones get harder to find every time something
// breaks. That is the junk problem: not volume, but zero-signal folders that look identical to signal.
//
// ── What counts as junk ─────────────────────────────────────────────────────────────────────────
// A meeting with NO CARDS produced nothing — whatever went wrong, there is no record worth keeping,
// and the transcript of a silent room is not a record. A meeting under a minute never got going.
// Both are safe to drop because the raw audio was never stored anyway, so nothing unique is lost.
//
// ⚠️ Never deletes without showing the list first. An archive is the one artefact of a conversation
// that cannot be regenerated, so the bar for removing one is that it demonstrably contains nothing.

import { readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ROOT = process.env.CANVAS_ARCHIVE_DIR || `${process.env.HOME}/.minami/meetings`;
const MODE = process.argv.includes("--prune") ? "prune" : process.argv.includes("--junk") ? "junk" : "list";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const grn = (s) => `\x1b[32m${s}\x1b[0m`;

function read(dir) {
  const p = join(ROOT, dir);
  try {
    if (!statSync(p).isDirectory()) return null;
  } catch { return null; }
  let meta = {};
  try { meta = JSON.parse(readFileSync(join(p, "canvas.json"), "utf8")); } catch { /* unreadable */ }
  const nodes = meta?.graph?.nodes ?? [];
  const cards = nodes.filter((n) => n.kind !== "topic").length;
  let lines = 0;
  try { lines = readFileSync(join(p, "transcript.md"), "utf8").split("\n").filter((l) => l.startsWith("- ")).length; } catch { /* none */ }
  return {
    dir,
    title: meta.title || dir,
    minutes: Number(meta.minutes ?? 0),
    cost: Number(meta.cost ?? 0),
    cards,
    lines,
    // No cards means nothing was ever built. Under a minute means it never started.
    junk: cards === 0 || Number(meta.minutes ?? 0) < 1,
  };
}

let dirs;
try { dirs = readdirSync(ROOT).filter((d) => !d.startsWith(".") && d !== "index.md"); }
catch { console.log(`\n  no archive at ${ROOT}\n`); process.exit(0); }

const all = dirs.map(read).filter(Boolean).sort((a, b) => b.dir.localeCompare(a.dir));
const junk = all.filter((m) => m.junk);
const keep = all.filter((m) => !m.junk);

const show = (m) => console.log(
  `  ${m.junk ? red("✗") : grn("✓")} ${m.dir.padEnd(34)} ${String(m.cards).padStart(3)} cards  ` +
  `${String(m.minutes).padStart(5)} min  ${String(m.lines).padStart(4)} lines  $${m.cost.toFixed(4)}`,
);

console.log(`\n  ${ROOT}`);
console.log(`  ${all.length} archived · ${keep.length} with content · ${junk.length} junk\n`);
if (MODE === "junk") junk.forEach(show);
else all.forEach(show);

if (MODE !== "prune") {
  if (junk.length && MODE === "list") console.log(`\n  ${dim(`${junk.length} produced no cards — see --junk, remove with --prune`)}`);
  console.log("");
  process.exit(0);
}

if (!junk.length) { console.log(`\n  ${grn("nothing to prune")}\n`); process.exit(0); }
const rl = createInterface({ input: stdin, output: stdout });
const a = (await rl.question(`\n  delete ${junk.length} folder(s) above? [y/N] `)).trim().toLowerCase();
rl.close();
if (a !== "y") { console.log(`  ${dim("kept")}\n`); process.exit(0); }
let n = 0;
for (const m of junk) { try { rmSync(join(ROOT, m.dir), { recursive: true, force: true }); n++; } catch { /* keep going */ } }
console.log(`  ${grn(`removed ${n}`)}  ${dim("(index.md keeps their rows as history)")}\n`);
