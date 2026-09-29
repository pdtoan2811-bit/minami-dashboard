// Bench omni ears on the same real meeting audio.
//
//   npx tsx scripts/ear-ab.mts [--ref model] [--n clips] [--slice 0-6] model1 model2 ...
//
// Clips come from ~/.minami/stt-samples (real voices, real rooms — synthetic speech cannot rank ears,
// see lib/canvas-modes.ts). Every model gets the same vault glossary the live path sends.
//
// ⚠️ THERE IS NO GROUND TRUTH. Quality is scored against a REFERENCE MODEL's transcript (default
// gemini-3.1-pro), so "WER" here means "disagreement with pro", not error. It ranks models that
// share pro's reading of an ambiguous word above ones that don't, and a model that is right where
// pro is wrong gets penalised. Good enough to separate tiers; read the transcripts before trusting a
// 2-point gap.
//
// Two silence clips go last, because "said nothing" must stay a legal answer — an ear that invents
// speech on silence puts a fabricated card on a customer's screen, which outweighs any WER gap.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
delete process.env.CANVAS_STT_MODEL;

const { loadVocab, asrPrompt } = await import("../server/canvas-vocab.mjs");
const { transcribe, noSpend } = await import("../lib/canvas-llm");

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i < 0 ? d : argv.splice(i, 2)[1]; };
const REF = opt("--ref", "google/gemini-3.1-pro-preview");
const N = Number(opt("--n", "12"));
// Which every-7th slice of the clips (0-6) — a second pass on different audio, same method.
const SLICE = Number(opt("--slice", "0"));
const omni = (m: string) => (m.startsWith("omni:") ? m : `omni:${m}`);
const MODELS = (argv.length ? argv : ["google/gemini-3-flash-preview", "google/gemini-3.8-flash"]).map(omni);

const dir = join(homedir(), ".minami/stt-samples");
// Largest clips first, then every 7th — spread across days and speakers rather than one monologue.
const clips = readdirSync(dir).filter((f) => f.endsWith(".wav"))
  .map((f) => ({ f, size: statSync(join(dir, f)).size }))
  .sort((a, b) => b.size - a.size)
  .filter((_, i) => i % 7 === SLICE)
  .slice(0, N);

// 16 kHz mono S16LE, wrapped the same way the live path wraps Recall's PCM. Optional low noise,
// because a real "silent" chunk is room hiss, not zeros.
function silence(seconds: number, noise = 0): Buffer {
  const data = Buffer.alloc(16000 * 2 * seconds);
  if (noise) for (let i = 0; i < data.length; i += 2) data.writeInt16LE(Math.round((Math.random() - 0.5) * noise), i);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const prompt = asrPrompt(await loadVocab(), []);

async function run(model: string, audio: Buffer, maxTokens?: number) {
  const spend = noSpend();
  const t0 = Date.now();
  try {
    const r = await transcribe({ kind: "stt", model, maxTokens }, audio, [], spend, "wav", prompt);
    return { text: r.lines.join(" "), ms: Date.now() - t0, cost: spend.cost, err: "" };
  } catch (e) {
    return { text: "", ms: Date.now() - t0, cost: spend.cost, err: (e as Error).message.slice(0, 120) };
  }
}

const words = (s: string) => s.toLowerCase().normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function wer(ref: string[], hyp: string[]): number {
  if (!ref.length) return hyp.length ? 1 : 0;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[hyp.length] / ref.length;
}
// English terms = ASCII-only words of 3+ letters in the reference; the thing this ear exists to keep.
const terms = (w: string[]) => w.filter((x) => /^[a-z][a-z0-9]{2,}$/.test(x));

type Row = { wer: number[]; termHit: number; termAll: number; ms: number[]; cost: number; errors: string[]; silence: string[] };
const rows: Record<string, Row> = Object.fromEntries(MODELS.map((m) => [m, { wer: [], termHit: 0, termAll: 0, ms: [], cost: 0, errors: [], silence: [] }]));

for (const c of clips) {
  const audio = readFileSync(join(dir, c.f));
  const [ref, ...outs] = await Promise.all([run(omni(REF), audio, 8192), ...MODELS.map((m) => run(m, audio))]);
  if (!ref.text) { console.log(`skip ${c.f} — reference ${ref.err ? "errored: " + ref.err : "heard nothing"}`); continue; }
  const rw = words(ref.text), rt = terms(rw);
  console.log(`\n\x1b[1m${c.f}\x1b[0m\n  \x1b[2mREF ${ref.text}\x1b[0m`);
  MODELS.forEach((m, i) => {
    const o = outs[i], r = rows[m];
    r.ms.push(o.ms); r.cost += o.cost;
    if (o.err) { r.errors.push(o.err); console.log(`  ${m.padEnd(40)} ERROR ${o.err}`); return; }
    const hw = words(o.text), hs = new Set(hw);
    r.wer.push(wer(rw, hw)); r.termAll += rt.length; r.termHit += rt.filter((t) => hs.has(t)).length;
    console.log(`  ${m.replace(/^omni:google\//, "").padEnd(26)} ${String(o.ms).padStart(5)}ms  wer ${(wer(rw, hw) * 100).toFixed(0).padStart(3)}%  ${o.text.slice(0, 110)}`);
  });
}

console.log("\n\x1b[1mSILENCE\x1b[0m");
for (const [label, audio] of [["3s zeros", silence(3)], ["5s room hiss", silence(5, 200)]] as const) {
  const outs = await Promise.all(MODELS.map((m) => run(m, audio)));
  MODELS.forEach((m, i) => {
    const t = outs[i].err ? `ERROR ${outs[i].err}` : outs[i].text;
    rows[m].silence.push(words(t).length ? `${words(t).length}w` : "∅");
    console.log(`  ${label.padEnd(13)} ${m.replace(/^omni:google\//, "").padEnd(26)} ${t ? t.slice(0, 100) : "∅"}`);
  });
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
console.log(`\n\x1b[1mSCOREBOARD\x1b[0m  vs ${REF}, ${clips.length} clips  (wer = disagreement with the reference, lower is better)`);
console.log(`  ${"model".padEnd(34)} ${"wer".padStart(5)} ${"terms".padStart(7)} ${"p50".padStart(6)} ${"p90".padStart(6)} ${"$/clip".padStart(9)}  silence   errors`);
for (const m of MODELS) {
  const r = rows[m];
  console.log(`  ${m.replace(/^omni:/, "").padEnd(34)} ${(mean(r.wer) * 100).toFixed(1).padStart(4)}% ${`${r.termHit}/${r.termAll}`.padStart(7)} ${(pct(r.ms, 0.5) / 1000).toFixed(1).padStart(5)}s ${(pct(r.ms, 0.9) / 1000).toFixed(1).padStart(5)}s ${(r.cost / (r.ms.length || 1)).toFixed(5).padStart(9)}  ${r.silence.join(",").padEnd(8)}  ${r.errors.length}`);
}
