// THE VOCABULARY — the thing that actually fixes the transcript.
//
// Three ASR models have now been made the default and two overturned, and every one of them mangles
// the same handful of words: "Minami" → "Minamino", "mind map" → "my mask", "real-time" → "real town".
// That is not a model quality problem and swapping models will never solve it. No general ASR has
// heard of Minami or qone, and a decoder that has never seen a word cannot output it.
//
// Worse than wrong text: on 2026-08-12 "Minamino" became the TOPIC NAME of an entire board. A single
// misheard proper noun propagated out of the transcript and into the structure, where every later
// card hung off it. Everything downstream — the judge, the cards, the archive, the email — inherits
// whatever the transcript says, so this is the one place a fix reaches all of them at once.
//
// ── Two interventions, because one is not enough ────────────────────────────────────────────────
//
//   BEFORE  terms are sent to the ASR as a decoding prompt, so it can produce the right word.
//   AFTER   known mishearings are rewritten, because biasing reduces errors and never eliminates them.
//
// The "after" pass is what makes this robust: it does not require the model to cooperate.
//
// ── Why a file anh can edit ─────────────────────────────────────────────────────────────────────
// He is the one who knows what he actually said. A correction he makes once should hold for every
// future meeting, which means it has to live somewhere durable rather than in a prompt someone
// retypes. `bin/vocab.mjs` is the CLI; this is the library.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const FILE = process.env.CANVAS_VOCAB_FILE || `${process.env.HOME}/.minami/canvas-vocab.json`;

/** Seeded from the terms already observed being mangled in real meetings. */
const SEED = {
  terms: [
    /** ⚠️ ORDER IS NOT COSMETIC — asrPrompt sends only the FIRST 40 and the rest never reach the ear.
     *
     *  "Claude" and "Anthropic" sat far down this list and were cut, while "CLAUDE.md" survived. So
     *  the ear was handed a list whose only legal Claude-shaped spellings were a filename and two
     *  compounds, and it wrote what it was allowed to write: "còn Claude thì để hỏi nhanh" came back
     *  as "còn CLAUDE.md thì để hỏi nhanh", and on the next pass even "Claude Code" became
     *  "CLAUDE.md Code".
     *
     *  A spelling list promotes anything it omits to whatever it contains. Where a short name and a
     *  longer one are both said, the SHORT one matters more — it is said far more often, and it is
     *  the one with somewhere wrong to land. */
    "Claude", "Claude Code", "Anthropic", "Minami", "mind map", "canvas", "Recall.ai", "Ownego", "qone", "QSortby",
    /** ⚠️ "Easy Vision AI" WAS SEEDED HERE AS IF IT WERE THE PRODUCT NAME. It is not — it is the
     *  MISHEARING of it. The vault's own project note says `title: Ecvision` and never once says
     *  "Easy Vision", yet this list taught the ear the wrong spelling on every single call, then the
     *  learning loop wrote that spelling into meeting notes, and the vault scanner harvested it back
     *  as authority. Seeding a mishearing is how one bad transcription becomes canon.
     *
     *  The real name is written `ecvision.ai` and SAID "EC Vision", so both reach the decoder, and
     *  every variant anh actually produces is mapped home in `fixes` below. */
    "Ecvision", "ecvision.ai", "EC Vision", "Hetzner", "Slack", "Second Brain", "real-time",
    /** ⚠️ THE CRAFT VOCABULARY, not just the proper nouns.
     *
     *  The vault sync fills this list with PROJECT NAMES — Minami, QSortby, Ecom Intel — because that
     *  is what gets [[linked]] in notes. But measured on one clip: the ear scored 8/8 on technical
     *  terms when the glossary contained them and 5/8 when it did not, mangling "workflow" into
     *  "Hugging Face" and "CLAUDE.md" into "Cloudinary". These are the words anh says in every single
     *  call and no note ever links to them, so nothing else was ever going to supply them. */
    "workflow", "agent", "context", "memory", "deploy", "vector search", "embedding",
    "prompt", "token", "latency", "endpoint", "webhook", "repo", "branch", "commit",
    "database", "schema", "migration", "cache", "queue", "pipeline", "transcript",
    "diarization",     /** ⚠️ "CLAUDE.md" IS DELIBERATELY NOT HERE. It is a filename: almost never said out loud, and
     *  close enough to "Claude" that its presence in a spelling list corrupts the far more common
     *  word. It stays in `fixes` below — "cloud md" → CLAUDE.md — which is where a rarely-spoken
     *  spelling belongs: applied when it is actually heard, never offered as a candidate. */
    "Claude CLI", "Cursor", "Figma", "Notion",
    "Obsidian", "Shopify", "Astro", "Next.js", "Remotion", "Playwright", "Supabase",

  ],
  fixes: {
    // Every one of these was observed in a real transcript, not imagined.
    "minamino": "Minami",
    "midami": "Minami",
    "my maps": "mind maps",
    "my map": "mind map",
    "my mask": "mind map",
    "mind mask": "mind map",
    "real town": "real-time",
    "recall ai": "Recall.ai",
    /** ⚠️ ONE PRODUCT, MANY WAYS OF SAYING IT — and the ear only has to get it wrong once for the
     *  board, the archive and the vault to inherit the error. "ecvision.ai" is said "EC Vision", and
     *  an English-trained decoder hearing Vietnamese-accented "EC" reaches for "Easy" every time.
     *  Reported directly: "I got a lot of Easy Vision when I say EC Vision."
     *
     *  All of them land on the vault's canonical `title:`. Longest-first matching is handled by
     *  correctText, so "Easy Vision AI" is consumed before "Easy Vision" can match inside it. */
    "easy vision ai": "Ecvision",
    "easy vision": "Ecvision",
    "e c vision": "Ecvision",
    "ec vision": "Ecvision",
    /** ⚠️ "Ecom Intel" and "Commerce360" are DELIBERATELY ABSENT, though the vault lists both as
     *  aliases of this same product. A fix rule rewrites what a person said, and those two are things
     *  anh actually says — not things the ear got wrong. Mapping them here turned
     *
     *    "bên Ecom Intel với Commerce360 gộp làm một"   (merge these two)
     *  into
     *    "bên Ecvision với Ecvision gộp làm một"        (merge it with itself)
     *
     *  — a sentence that no longer means what he said. Corrections are for MISHEARINGS. A synonym
     *  someone chose is theirs, and unifying identities is the board's job, not the transcript's. */
    // Blaze's characteristic error is SPLITTING a name it does not know into two Vietnamese-looking
    // syllables, rather than substituting a different word. Observed 2026-08-17 on the first real
    // clip: "Minami" → "Mi Nami". Its `prompt` field is inert, so post-correction is the only lever.
    // "Claude" has no Vietnamese neighbour, so every ear reaches for "cloud" — observed as "Cloud CLI",
    // "cloud md", "cloudem" and "Cloud đem" across three different models. Post-correction is the only
    // lever left: all three ASR prompt/biasing parameters were probed and proved inert.
    "cloud cli": "Claude CLI",
    "cloud code": "Claude Code",
    "cloud md": "CLAUDE.md",
    "cloudem": "CLAUDE.md",
    "mi nami": "Minami",
    "mi na mi": "Minami",
  },
};

/** MERGE the shipped seed with the saved file, file wins.
 *
 *  This used to RETURN the file whenever the file existed, so the seed was only ever consulted on a
 *  machine that had never run before. Every fix added to SEED after that first run was dead code on
 *  every existing install — added, committed, believed in, never loaded. Caught by adding the "mi nami"
 *  fix for Blaze and watching the correction not fire.
 *
 *  Merging the other way round would silently revert anh's own edits, so the file still wins on any
 *  key it defines; the seed only supplies keys the file has never heard of. */
export function loadVocab() {
  try {
    const d = JSON.parse(readFileSync(FILE, "utf8"));
    return {
      terms: [...new Set([...(SEED.terms ?? []), ...(d.terms ?? [])])],
      fixes: { ...(SEED.fixes ?? {}), ...(d.fixes ?? {}) },
    };
  } catch (e) {
    /** ⚠️ ONLY SEED WHEN THE FILE IS GENUINELY ABSENT.
     *
     *  This used to seed on ANY failure and then WRITE that seed back — so one transient read error,
     *  or a torn file caught mid-write by the launchd sync job, replaced 132 vault terms and every
     *  hand-taught correction with the 12-term default, permanently, with no backup and no message.
     *  A first run and a corrupted file are not the same event and must not have the same handler.
     *
     *  The returned object is also a COPY: the catch used to hand back SEED itself, which callers
     *  then mutated (ingest writes learned fixes into it), quietly editing the module constant for
     *  the lifetime of the process. */
    if (e && e.code !== "ENOENT") {
      console.error(`[vocab] could not read ${FILE} (${e.code ?? e.message}) — using defaults WITHOUT overwriting`);
      return { terms: [...SEED.terms], fixes: { ...SEED.fixes } };
    }
    saveVocab(SEED);
    return { terms: [...SEED.terms], fixes: { ...SEED.fixes } };
  }
}

export function saveVocab(v) {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    // TEMP + RENAME. The app and the launchd vault-sync job both write this file with no lock; a
    // plain writeFileSync truncates in place, so a reader landing mid-write sees a torn file — and
    // the reader's failure path used to overwrite it with defaults. rename is atomic on the same
    // filesystem, so a reader sees either the old file or the new one, never a broken one.
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(v, null, 2));
    renameSync(tmp, FILE);
  } catch (e) {
    console.error("[vocab] could not write:", e.message);
  }
}

/** What the ASR is told to expect.
 *
 *  Kept SHORT and put in a sentence rather than dumped as a list: a decoding prompt is conditioning
 *  context, not a dictionary lookup, and a wall of comma-separated tokens biases it toward producing
 *  a list. Capped because the prompt competes with the audio for the model's attention. */
/** ⚠️ THE LIVE GLOSSARY GOES FIRST, OR IT DOES NOT GO AT ALL.
 *
 *  `extra` is the highest-value signal there is: words scraped from what was said in the last minute
 *  of THIS meeting, plus anything anh corrected by hand mid-call. It was concatenated AFTER the vault
 *  list and the whole thing cut to 40 — and the vault list is now 179 terms, so `extra` was sliced off
 *  in its entirety, every call. Measured: passing "Recall" and "screenshare" as live keyterms, neither
 *  reached the decoder.
 *
 *  The cap itself is right (40 names is roughly what a decoder prompt can bias before the tail stops
 *  mattering). The ORDER was wrong: a general vocabulary was crowding out the specific one. */
export function asrPrompt(vocab, extra = []) {
  const terms = [...new Set([...extra, ...(vocab.terms ?? [])])].slice(0, 40);
  if (!terms.length) return undefined;
  return `This is a product meeting. Expect these names and terms: ${terms.join(", ")}.`;
}

/** Escape a phrase for use inside a RegExp. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrite known mishearings.
 *
 *  Longest-first so "my maps" is corrected before "my map" can match inside it — otherwise the shorter
 *  rule fires first and leaves "mind maps" as "mind mapss". Word-boundary anchored so a fix never
 *  fires inside a longer word.
 *
 *  Case is PRESERVED for the first letter only: a fix at the start of a sentence should not lowercase
 *  it, and a proper noun should keep its capital wherever it lands. */
export function correctText(text, vocab) {
  const fixes = Object.entries(vocab.fixes ?? {}).sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [wrong, right] of fixes) {
    out = out.replace(new RegExp(`\\b${esc(wrong)}\\b`, "gi"), (m) =>
      m[0] === m[0].toUpperCase() ? right[0].toUpperCase() + right.slice(1) : right,
    );
  }
  return out;
}

/** Correct a batch of transcript lines, and report what changed.
 *
 *  Returning the diff is deliberate: a silent correction layer is impossible to trust or debug, and
 *  the log line it produces is how anh finds out a fix is firing — or that a new mishearing needs one. */
export function correctLines(lines, vocab) {
  const changes = [];
  const corrected = lines.map((l) => {
    const c = correctText(l, vocab);
    if (c !== l) changes.push({ from: l, to: c });
    return c;
  });
  return { corrected, changes };
}

/** Teach it a new correction. */
export function learn({ term, was }) {
  const v = loadVocab();
  if (term && !v.terms.includes(term)) v.terms.push(term);
  if (was && term) v.fixes[was.toLowerCase()] = term;
  saveVocab(v);
  return v;
}
