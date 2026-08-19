#!/usr/bin/env node
// TEACH MINAMI THE NAMES SHE ALREADY OWNS.
//
//   node bin/vocab-from-vault.mjs            show what it would add, change nothing
//   node bin/vocab-from-vault.mjs --write    merge into the vocab file
//
// Every ASR failure that has actually hurt this project was a PROPER NOUN. Not grammar, not accent —
// names. "Minami" became "Minamino" and then became the topic name of a whole board. "Easy Vision AI"
// arrived as "EC Vision". "Hetzner" as "hét cho nghe". A decoder cannot output a word it has never
// seen, and no amount of model-swapping fixes that: qwen, whisper, chirp and Blaze all failed the same
// nouns in different ways.
//
// The names are not a mystery, though. They are already written down, hundreds of times, in the vault:
// [[Minami]] appears 196 times, [[Ecom Intel]] 177, [[QSortby]] 109. The Second Brain is the authority
// on what Thomas talks about, so it should be the authority on what Minami expects to hear.
//
// ── Where the terms go ──────────────────────────────────────────────────────────────────────────
//   asrPrompt()      the top 40 are sent as the decoder's `prompt`, which biases it toward producing
//                    the real spelling. This is a REAL parameter on OpenRouter's /audio/transcriptions
//                    — unlike provider.options.keyterm and unlike Blaze's `prompt`, both probed inert.
//   entity anchors   the full list seeds canvas-entities, so a mangled mention still clusters onto the
//                    right canonical name even when the decode was wrong.
//
// ⚠️ FREQUENCY ORDER IS LOad-BEARING. asrPrompt slices to 40, so an unranked list would silently drop
// whichever 60 sorted last — and the one that matters most ("Minami") could easily be among them.
// Sorting by vault mentions means the 40 that survive are the 40 most talked about.
//
// ⚠️ THE CLARITY FIREWALL IS RESPECTED. `40-49 Archive/` and `50-59 Sources/.raw/` are never read —
// they are explicitly not live context, and seeding the decoder from dead projects would bias it
// toward names nobody says any more.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";

const VAULT = process.env.SECOND_BRAIN_DIR || `${process.env.HOME}/secondBrain`;
const VOCAB = process.env.CANVAS_VOCAB_FILE || `${process.env.HOME}/.minami/canvas-vocab.json`;
const WRITE = process.argv.includes("--write");

const SKIP = ["40-49 Archive", "/.raw", "/node_modules", "/.git", "/.obsidian"];

/** Structural names — the vault's own scaffolding. They are frequent BECAUSE they are filenames, not
 *  because anyone says them out loud, and every one of them eats a slot in a 40-term budget that
 *  should be spent on "QSortby". Dropping them is the difference between biasing the decoder toward
 *  what Thomas talks about and biasing it toward how his notes are organised. */
const STRUCTURAL = new Set([
  "memory", "skill", "skills", "readme", "index", "archive index", "projects index", "sources index",
  "wiki index", "system index", "claude", "inbox", "daily", "template", "templates", "untitled",
  "notes", "note", "todo", "log", "logs", "map of content", "moc", "home", "dashboard",
]);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (SKIP.some((s) => p.includes(s))) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (e.endsWith(".md")) out.push(p);
  }
  return out;
}

/** A slug is how a FILE is named; a term is how a person SAYS it. "project-collection-sorter" is never
 *  spoken aloud — "collection sorter" is. Without this the decoder gets biased toward strings no human
 *  utters, which is worse than no bias at all. */
function spoken(raw) {
  let s = raw.trim().replace(/\.md$/i, "");
  if (!s || s.length > 40) return null;
  if (STRUCTURAL.has(s.toLowerCase())) return null;
  if (/^\d/.test(s) && /^[\d.\-\s]+$/.test(s)) return null;          // "00.02" style index files
  s = s.replace(/^project-/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (s.length < 3) return null;
  if (!/[a-zA-ZÀ-ỹ]/.test(s)) return null;
  if (STRUCTURAL.has(s.toLowerCase())) return null;
  return s;
}

const files = walk(VAULT);
const counts = new Map();
const bump = (t, n = 1) => { const k = spoken(t); if (k) counts.set(k, (counts.get(k) ?? 0) + n); };

for (const f of files) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }

  // [[wikilinks]] — the strongest signal: someone deliberately named a thing worth linking to.
  for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) bump(m[1]);

  // frontmatter aliases — the explicit "this is also called…" list, which is exactly a vocabulary.
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm) {
    const al = /aliases:\s*\[([^\]]+)\]/.exec(fm[1]) || /aliases:\s*\n((?:\s*-\s*.+\n?)+)/.exec(fm[1]);
    if (al) for (const a of al[1].split(/[,\n]/)) bump(a.replace(/^\s*-\s*/, "").replace(/["']/g, ""));
  }

  // The note's own title, worth one mention — a file nobody links to is still a subject that exists.
  bump(basename(f), 1);
}

const merged = new Map();
for (const [t, n] of counts) {
  const k = t.toLowerCase();
  const cur = merged.get(k);
  // Keep the spelling with more capitals — "QSortby" over "qsortby". The decoder is being taught how
  // the word is WRITTEN, so the canonical casing is the whole payload.
  const better = !cur || (t.replace(/[^A-Z]/g, "").length > cur.term.replace(/[^A-Z]/g, "").length);
  merged.set(k, { term: better ? t : cur.term, n: (cur?.n ?? 0) + n });
}

/** Ranked for the PROMPT: short names first. A 40-slot budget spent on "Context Guard Nudge Protocol"
 *  is a slot not spent on "Qikify". Long titles are lessons and stay as entity anchors, where length
 *  costs nothing. */
const ranked = [...merged.values()]
  .filter((e) => e.n >= 2 && e.term.split(/\s+/).length <= 5)
  .sort((a, b) => {
    const aShort = a.term.split(/\s+/).length <= 3 ? 1 : 0;
    const bShort = b.term.split(/\s+/).length <= 3 ? 1 : 0;
    if (aShort !== bShort) return bShort - aShort;
    return b.n - a.n || a.term.localeCompare(b.term);
  })
  .map((e) => [e.term, e.n]);

console.log(`\n  scanned ${files.length} live notes in ${VAULT}`);
console.log(`  ${ranked.length} terms mentioned twice or more\n`);
console.log(`  top 40 — these are what reach the decoder as its prompt:`);
for (const [t, n] of ranked.slice(0, 40)) console.log(`    ${String(n).padStart(4)}  ${t}`);
if (ranked.length > 40) console.log(`    …and ${ranked.length - 40} more, used as entity anchors only`);

if (!WRITE) {
  console.log(`\n  (dry run — re-run with --write to merge into ${VOCAB})\n`);
  process.exit(0);
}

let vocab = { terms: [], fixes: {} };
if (existsSync(VOCAB)) {
  try {
    vocab = JSON.parse(readFileSync(VOCAB, "utf8"));
  } catch (e) {
    /** ⚠️ REFUSE TO WRITE OVER A FILE YOU COULD NOT READ.
     *
     *  This catch was silent, and `vocab` was already initialised to { terms: [], fixes: {} } — so an
     *  unparseable file meant this job rewrote it with ZERO fixes and then printed "0 fixes kept" as
     *  though that were a success. Every hand-taught correction ("cloud cli" → "Claude CLI" and the
     *  rest) exists nowhere else and would be gone, on a 30-minute timer, unattended.
     *
     *  The whole invariant that lets two writers share this file — the job owns `terms`, the app owns
     *  `fixes` — depends on this job never touching the half it does not own. */
    console.error(`\n  ✗ ${VOCAB} exists but could not be parsed: ${e.message}`);
    console.error("    refusing to overwrite it — fix or delete the file, then re-run.\n");
    process.exit(1);
  }
}

// Vault terms FIRST and in rank order, then whatever was already there. asrPrompt takes the first 40,
// so this is what decides which names actually get biased.
const before = new Set(vocab.terms ?? []);
vocab.terms = [...new Set([...ranked.map(([t]) => t), ...(vocab.terms ?? [])])];
vocab.fixes = vocab.fixes ?? {};

mkdirSync(dirname(VOCAB), { recursive: true });
writeFileSync(VOCAB, JSON.stringify(vocab, null, 2));
const added = vocab.terms.filter((t) => !before.has(t)).length;
console.log(`\n  wrote ${VOCAB}`);
console.log(`  ${vocab.terms.length} terms total (${added} new), ${Object.keys(vocab.fixes).length} fixes kept\n`);
