#!/usr/bin/env node
// WHAT IS THIS MEETING ABOUT — company first, then the project, read from the Second Brain.
//
//   node bin/vault-projects.mjs            companies, then projects under each
//   node bin/vault-projects.mjs --json     machine-readable
//   node bin/vault-projects.mjs --flat     one flat ranked list (the old behaviour)
//
// Anh's flow before a call: "I want by company first, QDN or Ownego or ecvision.ai or personal,
// inside are projects or text input freely."
//
// ── Where the grouping comes from ───────────────────────────────────────────────────────────────
// Not invented here. Every note in `10-19 Projects/` already declares its allegiance in frontmatter
// `tags:` — qdn-website carries `qdn`, token-slayer carries `ownego`, ecvision carries
// `brand-intelligence`. Reading the tags means the picker stays correct as the vault changes, with no
// second list to maintain. A project whose tags say nothing lands under Personal, which is the honest
// default rather than a guess.
//
// Override anything by creating ~/.minami/companies.json:
//   { "Ownego": ["ownego", "qikify"], "QDN": ["qdn"], "ecvision.ai": ["ecvision"] }
// Keys are company names, values are tags (or project-name fragments) that belong to them.
//
// ⚠️ Clarity firewall: `40-49 Archive/` and `.raw/` are never read. A meeting is not about a project
// that was shelved a year ago.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const VAULT = process.env.SECOND_BRAIN_DIR || `${process.env.HOME}/secondBrain`;
const OVERRIDE = process.env.MINAMI_COMPANIES || `${process.env.HOME}/.minami/companies.json`;
const MODE = process.argv.includes("--json") ? "json" : process.argv.includes("--flat") ? "flat" : "tree";

/** The default map. Tags come straight from what the project notes already declare. */
let COMPANIES = {
  "Ownego": ["ownego", "qikify"],
  "QDN": ["qdn"],
  "ecvision.ai": ["ecvision", "brand-intelligence", "ecom-intel", "ecom intel"],
};
if (existsSync(OVERRIDE)) {
  try { COMPANIES = JSON.parse(readFileSync(OVERRIDE, "utf8")); } catch { /* keep defaults */ }
}

// ⚠️ `.minami-worktrees` holds git worktrees of the vault, each a FULL COPY including
// `10-19 Projects/`. Without this every project appeared once per worktree — seven identical
// "Ownego Guides" rows in the picker. Deduping by slug afterwards is still done as a belt-and-braces,
// because a copy can appear anywhere.
const SKIP = ["40-49 Archive", "/.raw", "/node_modules", "/.git", "/.obsidian", "/.minami-worktrees"];
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

const files = walk(VAULT);

/** How often the vault talks about a name — used to order projects within a company, so the one anh
 *  is actually working on sits at the top rather than whatever sorts first alphabetically. */
const mentions = new Map();
for (const f of files) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) {
    const k = m[1].trim().toLowerCase();
    mentions.set(k, (mentions.get(k) ?? 0) + 1);
  }
}

const titleCase = (s) =>
  s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/Qdn/g, "QDN").trim();

const projects = [];
for (const f of files.filter((x) => x.includes("10-19 Projects"))) {
  const slug = basename(f, ".md");
  if (slug === "index") continue;
  let head = "";
  try { head = readFileSync(f, "utf8").slice(0, 900); } catch { continue; }
  const tagLine = /tags:\s*\[([^\]]*)\]/i.exec(head);
  const tags = (tagLine?.[1] ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);

  // First company whose markers match a tag or the slug itself. Order of Object.keys decides ties,
  // which is why the override file is a plain object — the operator controls precedence.
  let company = "Personal";
  for (const [name, markers] of Object.entries(COMPANIES)) {
    if (markers.some((mk) => tags.includes(mk) || slug.includes(mk.replace(/\s+/g, "-")))) {
      company = name;
      break;
    }
  }
  /** Prefer the note's own H1 over a title-cased slug: the file is `qsortby.md` but the heading says
   *  "QSortby", and a picker that renames his product is a picker he has to translate. */
  const h1 = /^#\s+(.+)$/m.exec(head)?.[1]?.trim();
  const label = (h1 && h1.length <= 40 ? h1 : titleCase(slug)).replace(/\s*[—-].*$/, "").trim();
  projects.push({ company, name: label, slug, score: mentions.get(label.toLowerCase()) ?? 0 });
}

// Belt and braces against duplicate copies of a project note anywhere in the vault.
const bySlug = new Map();
for (const p of projects) if (!bySlug.has(p.slug)) bySlug.set(p.slug, p);
projects.length = 0;
projects.push(...bySlug.values());

const order = [...Object.keys(COMPANIES), "Personal"];
const tree = order
  .map((c) => ({
    company: c,
    projects: projects.filter((p) => p.company === c).sort((a, b) => b.score - a.score),
  }))
  .filter((g) => g.projects.length);

if (MODE === "json") {
  console.log(JSON.stringify(tree));
} else if (MODE === "flat") {
  projects.sort((a, b) => b.score - a.score).forEach((p, i) =>
    console.log(`${String(i + 1).padStart(2)}. ${p.name}`));
} else {
  // Numbered CONTINUOUSLY across companies, so anh types one number rather than a company-then-index
  // pair. The company is a heading, not a second prompt — one keystroke, not two.
  let n = 0;
  for (const g of tree) {
    console.log(`\n  ${g.company}`);
    for (const p of g.projects) console.log(`${String(++n).padStart(4)}. ${p.name}`);
  }
  console.log("");
}
