#!/usr/bin/env node
// PUBLISH THE MEETING CANVAS AS A STANDALONE PROJECT — without publishing Thomas.
//
//   node bin/sync-oss.mjs --dry     show exactly what would be copied and scrubbed
//   node bin/sync-oss.mjs           write it
//
// minami-dashboard is a personal workspace: it carries client names, a Second Brain, real meeting
// transcripts and a vault. The meeting canvas inside it is a general-purpose thing other people could
// run. This copies the second out of the first.
//
// ── THREE LAYERS, AND THE THIRD IS THE ONE THAT MATTERS ─────────────────────────────────────────
//
//   1. ALLOW    an explicit list of paths. A denylist would ship every new file by default, and the
//               default has to be "stays private" or one forgotten file leaks a client.
//   2. SCRUB    known names rewritten to neutral examples, so the code still reads naturally.
//   3. FORBID   the output is re-read and searched for anything personal. If a single term survives,
//               NOTHING is written and the offending file and line are printed.
//
// Layer 3 exists because layers 1 and 2 are written by hand and hand-written lists rot. A scrub that
// silently misses a name is worse than no scrub, because it is trusted. This one fails closed.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";

const SRC = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DEST = process.env.MINAMI_OSS_DIR || `${process.env.HOME}/minami-meet`;
const DRY = process.argv.includes("--dry");

/** ── 1. WHAT SHIPS ────────────────────────────────────────────────────────────────────────────
 *
 *  Whole directories where every file belongs, plus named files elsewhere. Anything not listed stays
 *  private by construction — including every future file, which is the point. */
const ALLOW_DIRS = [
  "app/canvas",
  "app/api/canvas",
  "app/api/memes",
  "components/canvas",
];
const ALLOW_FILES = [
  // the pipeline
  "lib/canvas-graph.ts", "lib/canvas-board.ts", "lib/canvas-llm.ts",
  "lib/canvas-commands.ts", "lib/canvas-modes.ts", "lib/canvas-trace.ts",
  "lib/canvas-audio.ts", "lib/edge-routing.ts", "lib/audio.ts",
  "server/recall-receiver.mjs", "server/utterance-chunker.mjs", "server/ws-min.mjs",
  "server/canvas-archive.mjs", "server/canvas-archive.d.mts",
  "server/canvas-vocab.mjs", "server/canvas-vocab.d.mts",
  "server/canvas-entities.mjs", "server/canvas-entities.d.mts",
  "server/canvas-budget.mjs",
  // the operator surface
  "bin/minami-meet.mjs", "bin/Minami Call.command", "bin/meme-preview.command",
  "bin/minami-setup.mjs", "bin/meetings.mjs", "bin/stt-compare.mjs",
  /** ⚠️ THE STYLESHEET IS NOT OPTIONAL, AND OMITTING IT SHIPPED A REPO THAT COULD NOT RUN.
   *
   *  The cut scene calls its keyframes BY NAME — cutWash, cutRing, cutGlyph, cutText — and they live
   *  here, as do .canvas-surface, .broadcast and the light-surface input colours. Without it the
   *  board renders unstyled and every cut scene animates to nothing. It is 911 lines of which only
   *  ~49 are canvas-specific; the rest is dashboard styling that is harmless, and cherry-picking CSS
   *  by hand is an excellent way to silently break a visual system. Whole file, scrubbed like the
   *  rest. */
  "app/globals.css",
];

/** ⚠️ DELIBERATELY ABSENT, and each for a reason:
 *
 *    bin/vault-projects.mjs, bin/meeting-to-vault.mjs, bin/vocab-from-vault.mjs
 *      The Second Brain integration. Useless without his vault and shaped entirely around it.
 *    app/api/meetings, app/meetings
 *      The archive browser — worth shipping eventually, but it reads a meetings directory whose
 *      layout is not yet stable, and shipping a broken page is worse than shipping none.
 *    public/memes/<any gif>
 *      His collection. The FOLDERS and the README ship (they are the taxonomy, and the whole point
 *      is that someone else fills them); the images never do. They are his, and some are certainly
 *      somebody else's. */

/** ── 2. WHAT GETS REWRITTEN ───────────────────────────────────────────────────────────────────
 *
 *  Ordered longest-first so "Minami Dashboard" is consumed before "Minami" can match inside it.
 *  These are not redactions — the aim is code that still reads like it was written for a real
 *  meeting, because the comments explaining WHY something is the way it is are most of the value
 *  here. A neutral example keeps the sentence true. */
/** ⚠️ CASE-INSENSITIVE, ALL OF THEM. The first version matched exact case and the guard did the
 *  same, so the two shared a blind spot and agreed with each other about a clean result. An
 *  independent case-insensitive grep of the OUTPUT found three leaks the guard had passed:
 *  "commerce360" in a quoted transcript, "second brain" in a benchmark note, and — worst —
 *  "/Users/thomas/Downloads/…" hardcoded in two file paths.
 *
 *  A check that shares its assumptions with the thing it checks is not a check. Both layers are now
 *  case-insensitive, and the home directory is scrubbed as a path, not as a name. */
const SCRUB = [
  [/\/Users\/[a-z0-9._-]+\//gi, "/Users/you/"],
  [/Easy Vision AI|ecvision\.ai|Ecvision|ecvision/gi, "Acme Vision"],
  [/Commerce360/gi, "Acme Commerce"],
  [/QDN Digital|QDN Website|QDN/gi, "Northwind"],
  [/Ownego Guides|Ownego/gi, "Contoso"],
  [/QSortby/gi, "Sortly"],
  [/Token Slayer|token-slayer/gi, "keyring"],
  [/\bqone\b/gi, "the task app"],
  [/phạm đức toàn|pdtoan2811-bit|pdtoan2811/gi, "the operator"],
  [/\bTùng\b/gi, "Alex"],
  [/com\.thomas\./gi, "com.example."],
  [/\bThomas\b/gi, "the operator"],
  [/\banh\b(?=\s|,|\.)/g, "the operator"],   // "anh" is how these comments address him
  // Real rooms, real people, real machines.
  [/[a-z]{3}-[a-z]{4}-[a-z]{3}(?=[^a-z]|$)/g, "xxx-yyyy-zzz"],
  [/https:\/\/[a-z-]+\.trycloudflare\.com/g, "https://example.trycloudflare.com"],
  [/\bHetzner\b/gi, "the server"],
  [/secondBrain|second brain/gi, "your notes"],
  [/~\/minami-dashboard|minami-dashboard/gi, "minami-meet"],
];

/** ── 3. WHAT MUST NOT SURVIVE ─────────────────────────────────────────────────────────────────
 *
 *  Checked against the SCRUBBED output. A hit here aborts the whole run: no partial publish, because
 *  a half-scrubbed repo is a leaked one. */
const FORBID = [
  "QDN", "Ownego", "Ecvision", "ecvision", "Commerce360", "QSortby", "qone",
  "phạm đức toàn", "pdtoan2811", "Tùng", "Thomas", "secondBrain", "Second Brain",
  "udm-aion-awd", "trycloudflare.com/", "Hetzner",
  /** ⚠️ CREDENTIALS ARE MATCHED BY VALUE, NOT BY NAME. Forbidding the string "RECALL_API_KEY=" also
   *  forbids `usage: RECALL_API_KEY=… node bin/minami-meet.mjs`, which is documentation and exactly
   *  what a newcomer needs. The first run of this guard aborted on two such lines — a check that
   *  cries wolf on its own help text gets switched off, and then it is protecting nothing.
   *
   *  So these match a key SHAPE: an assignment followed by something long enough to be real. */
  /sk-or-v1-[A-Za-z0-9_-]{12,}/,
  /(?:API_KEY|INGEST_TOKEN|SECRET|PASSWORD)\s*=\s*["']?[A-Za-z0-9_\-]{16,}/,
];

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(join(SRC, dir))) {
    const rel = join(dir, e);
    const st = statSync(join(SRC, rel));
    if (st.isDirectory()) walk(rel);
    else files.push(rel);
  }
};
for (const d of ALLOW_DIRS) if (existsSync(join(SRC, d))) walk(d);
for (const f of ALLOW_FILES) if (existsSync(join(SRC, f))) files.push(f);

const TEXT = /\.(ts|tsx|mjs|js|json|md|css|command|sh)$/i;
const out = [];
const violations = [];

for (const rel of files) {
  const raw = readFileSync(join(SRC, rel));
  if (!TEXT.test(rel)) { out.push({ rel, binary: raw }); continue; }
  let text = raw.toString("utf8");
  const before = text;
  for (const [re, to] of SCRUB) text = text.replace(re, to);
  for (const term of FORBID) {
    // Case-insensitive for the same reason the scrub is — see the note above SCRUB.
    const hit = typeof term === "string" ? text.toLowerCase().includes(term.toLowerCase()) : term.test(text);
    if (!hit) continue;
    for (const [i, line] of text.split("\n").entries()) {
      const bad = typeof term === "string" ? line.toLowerCase().includes(term.toLowerCase()) : term.test(line);
      if (bad) violations.push({ rel, line: i + 1, term: String(term), text: line.trim().slice(0, 100) });
    }
  }
  out.push({ rel, text, changed: text !== before });
}

// ── the meme folders, without the memes ────────────────────────────────────────────────────────
const memeDirs = existsSync(join(SRC, "public/memes"))
  ? readdirSync(join(SRC, "public/memes")).filter((d) => {
      try { return statSync(join(SRC, "public/memes", d)).isDirectory(); } catch { return false; }
    })
  : [];

if (violations.length) {
  console.error(`\n  ✗ REFUSING TO PUBLISH — ${violations.length} private reference(s) survived the scrub:\n`);
  for (const v of violations.slice(0, 25)) {
    console.error(`    ${v.rel}:${v.line}  "${v.term}"`);
    console.error(`      ${v.text}`);
  }
  if (violations.length > 25) console.error(`    …and ${violations.length - 25} more`);
  console.error(`\n  Nothing was written. Add a SCRUB rule in bin/sync-oss.mjs, or drop the file from ALLOW.\n`);
  process.exit(1);
}

const scrubbed = out.filter((o) => o.changed).length;
console.log(`\n  ${files.length} file(s) from ${relative(process.env.HOME, SRC)}`);
console.log(`  ${scrubbed} scrubbed, ${violations.length} violations`);
console.log(`  ${memeDirs.length} meme folder(s) recreated empty (your gifs stay here)`);

if (DRY) {
  console.log(`\n  dry run — nothing written. Would go to ${DEST}\n`);
  for (const o of out.filter((x) => x.changed).slice(0, 12)) console.log(`    scrubbed  ${o.rel}`);
  process.exit(0);
}

for (const o of out) {
  const dest = join(DEST, o.rel);
  mkdirSync(dirname(dest), { recursive: true });
  if (o.binary) writeFileSync(dest, o.binary);
  else writeFileSync(dest, o.text);
}
for (const d of memeDirs) {
  mkdirSync(join(DEST, "public/memes", d), { recursive: true });
  writeFileSync(join(DEST, "public/memes", d, ".gitkeep"), "");
}
if (existsSync(join(SRC, "public/memes/README.md"))) {
  let readme = readFileSync(join(SRC, "public/memes/README.md"), "utf8");
  for (const [re, to] of SCRUB) readme = readme.replace(re, to);
  writeFileSync(join(DEST, "public/memes/README.md"), readme);
}

/** ── SCAFFOLDING ──────────────────────────────────────────────────────────────────────────────
 *
 *  Written only if absent, never overwritten. These are the files a maintainer edits by hand — a
 *  README grows examples, a package.json gains dependencies — and a sync that clobbered them would
 *  make the standalone repo unmaintainable: every improvement lost on the next push from upstream.
 *  The CODE is owned by minami-meet and overwritten every time; the PACKAGING is owned by the repo. */
const scaffold = {
  /** ⚠️ WITHOUT THESE THE REPO IS NOT A PROJECT, IT IS A FOLDER OF FILES.
   *
   *  The first sync shipped 54 files and no package.json, tsconfig, next.config, postcss config or
   *  root layout — so `npm install` had nothing to install, `@/` resolved to nothing, and Next
   *  refused to start for want of app/layout.tsx. It passed a privacy audit and could not run. A
   *  standalone repo that does not start is worse than no repo: it wastes the time of everyone who
   *  clones it and it makes the project look abandoned on arrival. */
  "package.json": JSON.stringify({
    name: "minami-meet",
    version: "0.1.0",
    private: false,
    description: "A bot joins your Google Meet, listens, and draws a live mind map you screen-share back",
    scripts: {
      // First thing a newcomer runs. It fills .env.local interactively, generates the shared token,
      // and CALLS each service to prove the credential works rather than that it is merely present.
      setup: "node bin/minami-setup.mjs",
      doctor: "node bin/minami-setup.mjs --check",
      dev: "next dev",
      build: "next build",
      start: "next start",
      receiver: "node server/recall-receiver.mjs",
    },
    // Only what the shipped code imports. Verified by grepping the extracted tree rather than
    // copied from upstream, which carries a dashboard's worth of dependencies this does not use.
    dependencies: { next: "^15.5.22", react: "19.0.0", "react-dom": "19.0.0" },
    devDependencies: {
      "@tailwindcss/postcss": "^4.0.0", "@types/node": "^22", "@types/react": "^19",
      "@types/react-dom": "^19", tailwindcss: "^4.0.0", typescript: "^5",
    },
  }, null, 2) + "\n",

  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      target: "ES2022", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, skipLibCheck: true,
      strict: true, noEmit: true, esModuleInterop: true, module: "esnext",
      moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true,
      jsx: "preserve", incremental: true,
      plugins: [{ name: "next" }],
      // The @/ alias every shipped file imports through. Without this nothing resolves.
      paths: { "@/*": ["./*"] },
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  }, null, 2) + "\n",

  "next.config.mjs": `/** @type {import('next').NextConfig} */
// Deliberately minimal. Upstream carries a webpack override that cuts an unrelated subsystem out of
// the edge bundle; none of that code is here, so shipping the workaround would just be cargo cult.
const nextConfig = {
  // Lets a second instance use its own build dir, so the meeting app and any other Next app on the
  // machine do not fight over .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};
export default nextConfig;
`,

  "postcss.config.mjs": `const config = { plugins: { "@tailwindcss/postcss": {} } };
export default config;
`,

  "app/layout.tsx": `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "minami-meet",
  description: "A live mind map of your meeting",
};

/** ⚠️ The canvas is a LIGHT surface inside a dark shell, and globals.css is written for exactly that
 *  arrangement — including the rule that gives form controls a dark colour on the light board. Change
 *  the classes here and the cut scene and the command dock change with them. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
`,

  LICENSE: `MIT License

Copyright (c) ${new Date().getFullYear()} minami-meet contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,

  ".gitignore": `node_modules/\n.next/\n.next-*/\n.env.local\n*.log\n\n# Bring your own memes. The folders ship; the images are yours.\npublic/memes/**/*.gif\npublic/memes/**/*.png\npublic/memes/**/*.jpg\npublic/memes/**/*.webp\n`,

  ".env.example": `# The two keys this needs, and nothing else.\n\n# https://recall.ai — puts a bot in the call and streams per-participant audio\nRECALL_API_KEY=\nRECALL_REGION=us-west-2\n\n# https://openrouter.ai — the ear (audio in) and the judge (cards out)\nOPENROUTER_API_KEY=\n\n# Any long random string. Shared by the receiver and the app; without it ingest is refused.\nCANVAS_INGEST_TOKEN=\n\n# Optional. Defaults are in lib/canvas-modes.ts and are the ones actually in use.\n# CANVAS_STT_MODEL=omni:google/gemini-3-flash-preview\n# CANVAS_SILENCE_MS=1000\n`,

  "README.md": `# minami-meet

A bot joins your Google Meet, listens, and draws a live mind map of the conversation that you
screen-share back into the room.

Not a transcript. A **board**: decisions, actions, open questions and risks as cards, nested under
topics, appearing while people are still talking — so the room can see what has been agreed without
anyone taking notes.

## How it works

    Google Meet ── Recall.ai ──▶ receiver ──▶ ear ──▶ judge ──▶ canvas ──▶ your shared tab
                   (a bot)      (per speaker)  (STT)   (cards)

- **Recall.ai** puts a bot in the call and streams each participant's audio separately, with their
  name attached. No diarization needed — speaker identity comes off the wire.
- **The receiver** cuts each speaker's stream on their own pauses, so an utterance arrives whole.
- **The ear** is an audio-capable chat model rather than a pure ASR, because it can be *told* things:
  your product names, that the speaker code-switches, that several people share one microphone.
- **The judge** turns each utterance into board operations. It is told the transcript is imperfect
  speech-to-text and that returning nothing is a correct answer.
- **The canvas** is what you share. It also plays a full-screen cut scene when a moment lands.

## Running it

    npm install
    npm run setup                  # asks for the two keys, generates the rest, verifies both
    ./bin/Minami\\ Call.command    # or: npm run dev, then open /canvas

\`npm run setup\` is interactive and does not print secrets. It calls Recall and OpenRouter to prove
each key works — "present" is not "works", and a rotated key looks identical to a good one in a file.
\`npm run doctor\` re-runs the checks read-only and exits non-zero if anything is missing.

The launcher starts the app, the audio receiver and a tunnel, then puts a bot in the meeting you give
it. Share the tab it opens.

## Memes

\`public/memes/\` has one folder per cut-scene moment. Drop GIFs in and they play instead of the emoji;
leave a folder empty and it falls back. \`./bin/meme-preview.command\` plays every moment back to back
so you can judge a collection without holding a meeting. See \`public/memes/README.md\`.

## What this costs

Recall bills per bot-minute. The ear and the judge bill per token — roughly a few cents per meeting
at the default models. \`server/canvas-budget.mjs\` enforces a ceiling.

## Status

Extracted from a working personal setup, so the comments are unusually candid about what went wrong
and why things are the way they are. Read them — most of the design decisions here were bought with a
broken meeting.
`,
};

for (const [name, body] of Object.entries(scaffold)) {
  const dest = join(DEST, name);
  if (existsSync(dest)) { console.log(`  kept your ${name}`); continue; }
  writeFileSync(dest, body);
  console.log(`  created ${name}`);
}

console.log(`\n  wrote ${DEST}\n`);
