#!/usr/bin/env node
// WHICH ASR ACTUALLY HEARS YOU — run one clip through every candidate, side by side.
//
//   node bin/stt-compare.mjs <file.wav> ["glossary,terms,here"]
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// grok-stt-1.0 was chosen on a spec sheet: 25+ languages, mid-stream switching, cheapest tier. Nobody
// ever tested it on the voice it would actually be listening to. Accented English and VI/EN
// code-switching is the hard case for ASR and the entire use case here, and a catalogue description
// cannot tell you which model handles it — only the audio can.
//
// Cost is a rounding error at this scale (a 10-second clip across eight models is well under a cent),
// so the only reason not to have run this weeks ago is that nobody had a clip of the real voice.
//
// ── The glossary argument ───────────────────────────────────────────────────────────────────────
// Some of these accept a PROMPT that biases decoding toward expected vocabulary. That matters more
// than raw accuracy for this workload: "Easy Vision AI", "SCP", "qone", "Ownego" are exactly the words
// a general model will mangle, and exactly the words the board needs right. The pipeline already
// computes a glossary from what has been said — pass it here and see who uses it.

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const FILE = process.argv[2];
const GLOSSARY = (process.argv[3] || "").split(",").map((s) => s.trim()).filter(Boolean);
const KEY = process.env.OPENROUTER_API_KEY;
const BASE = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

if (!FILE || !KEY) {
  console.error("usage: OPENROUTER_API_KEY=… node bin/stt-compare.mjs <file.wav> [\"term,term\"]");
  process.exit(1);
}

/** The shortlist, and why each is on it.
 *
 *  Chosen for the actual workload — accented English mixed with Vietnamese — not for benchmark scores
 *  on read American English, which is the case none of these meetings resemble. */
const MODELS = [
  ["x-ai/grok-stt-1.0", "current default — picked for language switching, never tested on this voice"],
  ["openai/gpt-4o-transcribe", "LLM-based: uses context, historically strongest on accented speech"],
  ["openai/gpt-4o-mini-transcribe", "same family, cheaper — worth knowing if the gap is small"],
  ["openai/whisper-large-v3", "the accent-robustness benchmark; 99 languages"],
  ["google/chirp-3", "Google multilingual, strong Vietnamese"],
  ["qwen/qwen3-asr-flash-2026-02-10", "Alibaba, trained heavily on Asian-accented speech"],
  ["deepgram/nova-3", "Vietnamese as a monolingual selection"],
  ["mistralai/voxtral-mini-transcribe", "cheap outsider — include it so 'expensive is better' stays a finding, not an assumption"],
];

const audio = readFileSync(FILE).toString("base64");
const seconds = (readFileSync(FILE).length - 44) / 32000;

console.log(`\n  ${basename(FILE)} — ${seconds.toFixed(1)}s of audio`);
if (GLOSSARY.length) console.log(`  glossary: ${GLOSSARY.join(", ")}`);
console.log("");

async function run(model, note) {
  const t0 = Date.now();
  const body = {
    model,
    input_audio: { data: audio, format: "wav" },
    // Bias decoding toward the words we already know are in play. Silently ignored by models that
    // don't support it, which is itself part of what this compares.
    ...(GLOSSARY.length ? { prompt: `Terms used in this meeting: ${GLOSSARY.join(", ")}.` } : {}),
  };
  try {
    const res = await fetch(`${BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = JSON.parse(await res.text());
    const ms = Date.now() - t0;
    if (d.error) return { model, note, err: JSON.stringify(d.error).slice(0, 90), ms };
    const cost = d.usage?.cost ?? 0;
    return { model, note, text: (d.text ?? "").trim(), ms, cost, perHour: seconds ? (cost / seconds) * 3600 : 0 };
  } catch (e) {
    return { model, note, err: e.message.slice(0, 90), ms: Date.now() - t0 };
  }
}

// Concurrently: they are independent, and eight sequential round trips is a minute of waiting for no
// reason.
const results = await Promise.all(MODELS.map(([m, n]) => run(m, n)));

for (const r of results) {
  console.log(`── ${r.model}`);
  console.log(`   ${r.note}`);
  if (r.err) {
    console.log(`   ERROR: ${r.err}\n`);
    continue;
  }
  console.log(`   ${(r.ms / 1000).toFixed(1)}s · $${r.cost.toFixed(6)} · ~$${r.perHour.toFixed(3)}/audio-hour`);
  console.log(`   "${r.text || "(empty)"}"\n`);
}

const ok = results.filter((r) => !r.err && r.text);
if (ok.length) {
  console.log("── cheapest / fastest ──");
  console.log(`   cheapest: ${[...ok].sort((a, b) => a.perHour - b.perHour)[0].model}`);
  console.log(`   fastest:  ${[...ok].sort((a, b) => a.ms - b.ms)[0].model}`);
  console.log("\n   Accuracy is YOURS to judge — read the transcripts above against what you actually said.");
  console.log("   No proxy metric can rank these; that is the whole reason this prints them side by side.\n");
}
