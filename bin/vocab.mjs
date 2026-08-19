#!/usr/bin/env node
// Teach Minami a word she keeps getting wrong.
//
//   node bin/vocab.mjs list
//   node bin/vocab.mjs add "mind map" --was "my mask"
//   node bin/vocab.mjs add "Minami"
//   node bin/vocab.mjs test "she draws my mask on canvas"
//
// The correction holds for every future meeting, and reaches everything downstream at once — the
// judge reads the corrected transcript, so the cards, the archive and the email all inherit it.

import { loadVocab, learn, correctText } from "../server/canvas-vocab.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const v = loadVocab();

if (cmd === "list" || !cmd) {
  console.log(`\n  terms (${v.terms.length}) — biased into the ASR decode:`);
  for (const t of v.terms) console.log(`    ${t}`);
  console.log(`\n  fixes (${Object.keys(v.fixes).length}) — rewritten after transcription:`);
  for (const [w, r] of Object.entries(v.fixes)) console.log(`    "${w}" → "${r}"`);
  console.log("");
} else if (cmd === "add") {
  const term = rest[0];
  const i = rest.indexOf("--was");
  const was = i >= 0 ? rest[i + 1] : undefined;
  if (!term) { console.error('usage: vocab.mjs add "Correct Term" [--was "what it heard"]'); process.exit(1); }
  learn({ term, was });
  console.log(was ? `  learned: "${was}" → "${term}"` : `  added term: ${term}`);
} else if (cmd === "test") {
  const line = rest.join(" ");
  console.log(`  in : ${line}`);
  console.log(`  out: ${correctText(line, v)}`);
} else {
  console.error("commands: list | add | test");
  process.exit(1);
}
