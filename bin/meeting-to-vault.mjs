#!/usr/bin/env node
// THE LEARNING LOOP — a finished call becomes part of the Second Brain.
//
//   node bin/meeting-to-vault.mjs <meeting-id> [--project qsortby] [--dry]
//
// Without this the archive is a dead end: Minami captures a conversation beautifully and files it
// somewhere the rest of the system never looks. The vault is where Thomas actually thinks, so a
// meeting that never reaches it may as well not have happened — "losing the thread" is the stated #1
// bottleneck, and an archive nobody opens is exactly how a thread gets lost.
//
// What it writes:
//   1. A meeting note in `50-59 Sources/meetings/` — the board as markdown, entities wikilinked.
//   2. A dated line appended to the matching `10-19 Projects/<project>.md`, so the project note —
//      the thing that IS read — carries the fact that this call happened and what came out of it.
//
// ── ONE WAY, always ─────────────────────────────────────────────────────────────────────────────
// Meeting → vault. Never vault → meeting. Speech-to-text mishears constantly, and letting a call
// edit the vault's own prose would let a mis-transcription overwrite something Thomas wrote by hand.
// This only ever APPENDS, and only to two places.
//
// ⚠️ Existing vault content is never rewritten. The project note gets one new line under a heading
// this script owns; if that heading is missing it is created at the end of the file.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";

const VAULT = process.env.SECOND_BRAIN_DIR || `${process.env.HOME}/secondBrain`;
const ROOT = process.env.CANVAS_ARCHIVE_DIR || `${process.env.HOME}/.minami/meetings`;
const DRY = process.argv.includes("--dry");

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : undefined; };
const ID = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined;
if (!ID) {
  console.error("usage: node bin/meeting-to-vault.mjs <meeting-id> [--project slug] [--dry]");
  process.exit(2);
}

const dir = join(ROOT, ID);
if (!existsSync(dir)) { console.error(`no such meeting: ${ID}`); process.exit(1); }

let meta = {};
try { meta = JSON.parse(readFileSync(join(dir, "canvas.json"), "utf8")); } catch { /* partial is fine */ }
const nodes = meta?.graph?.nodes ?? [];
const cards = nodes.filter((n) => n.kind !== "topic");
if (!cards.length) { console.log("  nothing to sync — this meeting produced no cards"); process.exit(0); }

/** The vocabulary is the entity list. Every term the vault knows becomes a [[wikilink]] when it
 *  appears in a card, which is what makes the meeting show up in that project's backlinks — the
 *  payoff for the whole vault-sync vocabulary pipeline. */
let terms = [];
try {
  const v = JSON.parse(readFileSync(process.env.CANVAS_VOCAB_FILE || `${process.env.HOME}/.minami/canvas-vocab.json`, "utf8"));
  terms = (v.terms ?? []).filter((t) => t.length > 3).sort((a, b) => b.length - a.length).slice(0, 120);
} catch { /* no vocabulary yet — the note is still worth writing */ }

const linked = (text) => {
  let out = text;
  for (const t of terms) {
    // Longest-first (sorted above) so "Minami Dashboard" wins over "Minami", and only the FIRST
    // occurrence is linked — a note where every mention is a link is unreadable.
    const re = new RegExp(`(?<!\\\\[)\\\\b${t.replace(/[.*+?^${}()|[\]\\\\]/g, "\\\\$&")}\\\\b(?!\\\\])`, "i");
    if (re.test(out) && !out.includes(`[[${t}`)) out = out.replace(re, `[[${t}]]`);
  }
  return out;
};

const byId = new Map(nodes.map((n) => [n.id, n]));
const topicOf = (n) => {
  let cur = n, hops = 0;
  while (cur && hops++ < 16) {
    if (cur.kind === "topic" && cur.id !== "root") return cur.label;
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return null;
};

const KIND_ORDER = ["decision", "action", "question", "risk", "milestone", "requirement", "note", "quote", "aside"];
const HEAD = {
  decision: "Decisions", action: "Actions", question: "Open questions", risk: "Risks",
  milestone: "Milestones", requirement: "Requirements", note: "Notes", quote: "Moments", aside: "Bên lề",
};

const when = `${(meta.startedAt ? new Date(meta.startedAt) : new Date()).toISOString().slice(0, 10)}`;

/** Same derivation the library uses: the FIRST topic is always the worst one, because a meeting opens
 *  with small talk. Rank topics by how much hangs off them and take the top two. Without this every
 *  vault note would be filed as "Meeting", which is precisely the dead end this script exists to fix. */
function deriveTitle() {
  const stored = (meta.title ?? "").trim();
  if (stored && !/^(meeting|cu\u1ed9c h\u1ecdp)$/i.test(stored)) return stored;
  const count = (id, seen = new Set()) => {
    let n = 0;
    for (const c of nodes) if (c.parent === id && !seen.has(c.id)) { seen.add(c.id); n += 1 + count(c.id, seen); }
    return n;
  };
  const ranked = nodes
    .filter((n) => n.kind === "topic" && n.id !== "root" && (n.label ?? "").trim().length > 1)
    .map((t) => ({ label: t.label.trim(), n: count(t.id) }))
    .sort((a, b) => b.n - a.n);
  if (!ranked.length) return stored || basename(dir);
  return ranked.length > 1 && ranked[1].n >= 2 ? `${ranked[0].label} · ${ranked[1].label}` : ranked[0].label;
}
const title = deriveTitle();

const lines = [
  "---",
  `tags: [meeting, minami]`,
  `date: ${when}`,
  "---",
  "",
  `# ${title}`,
  "",
  `- **When:** ${when} · ${meta.minutes ?? 0} min`,
  `- **Captured by:** [[Minami]]`,
  `- **Archive:** \`${ID}\``,
  "",
];
for (const k of KIND_ORDER) {
  const group = cards.filter((c) => c.kind === k);
  if (!group.length) continue;
  lines.push(`## ${HEAD[k] ?? k}`, "");
  for (const c of group) {
    const t = topicOf(c);
    lines.push(`- **${linked(c.label)}**${t ? `  ·  _${t}_` : ""}`);
    if (c.detail) lines.push(`  ${linked(c.detail)}`);
  }
  lines.push("");
}

const outDir = join(VAULT, "50-59 Sources", "meetings");
const outFile = join(outDir, `${when}-${title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60)}.md`);

// ── the project note: one appended line, under a heading this script owns ───────────────────────
const projectSlug = arg("--project");
let projectFile = null;
if (projectSlug) {
  const cand = join(VAULT, "10-19 Projects", `${projectSlug}.md`);
  if (existsSync(cand)) projectFile = cand;
}
const decisions = cards.filter((c) => c.kind === "decision").slice(0, 2).map((c) => c.label);
const actions = cards.filter((c) => c.kind === "action").slice(0, 2).map((c) => c.label);
const summary = [...decisions, ...actions].join("; ") || `${cards.length} cards captured`;
const projectLine = `- ${when} — [[${basename(outFile, ".md")}]] · ${summary}`;

if (DRY) {
  console.log(`\n  would write  ${outFile}`);
  console.log(`  ${lines.length} lines, ${cards.length} cards`);
  if (projectFile) console.log(`  would append to ${projectFile}:\n    ${projectLine}`);
  else if (projectSlug) console.log(`  project note not found for "${projectSlug}" — skipping the append`);
  console.log("");
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, lines.join("\n"));
console.log(`  wrote ${outFile}`);

if (projectFile) {
  const body = readFileSync(projectFile, "utf8");
  const HEADING = "## Meetings";
  if (body.includes(HEADING)) {
    // Insert directly under the heading so the newest call is the first thing read.
    writeFileSync(projectFile, body.replace(HEADING, `${HEADING}\n\n${projectLine}`));
  } else {
    appendFileSync(projectFile, `\n\n${HEADING}\n\n${projectLine}\n`);
  }
  console.log(`  linked into ${basename(projectFile)}`);
}
console.log("");
