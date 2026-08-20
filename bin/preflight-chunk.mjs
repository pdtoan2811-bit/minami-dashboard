#!/usr/bin/env node
// ONE REAL UTTERANCE, ALL THE WAY THROUGH — the part of pre-flight that actually proves something.
//
//   node bin/preflight-chunk.mjs [port]
//
// Synthesises a short Vietnamese-with-English-terms clip, posts it to the live ingest endpoint, and
// waits for a card to land. That exercises every leg the real thing uses: the ear, the vocabulary,
// the judge, the board and the publish — with the same models and the same code path a meeting takes.
//
// ⚠️ IT USES A THROWAWAY meetingId AND ENDS IT. Publishing under a real meeting's id would put a test
// card on a board anh is about to share, and the boards are per-meeting precisely so that cannot
// happen by accident. The session is ended so it archives and does not linger in memory.
//
// Costs a fraction of a cent. That is the point: the alternative is finding out during a call.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.argv[2] || "3011";
const BASE = `http://127.0.0.1:${PORT}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const no = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

/** Read the token the way the app does: first declaration wins, which is how a duplicated key once
 *  left this endpoint wide open. */
function token() {
  const p = new URL("../.env.local", import.meta.url).pathname;
  if (!existsSync(p)) return "";
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*CANVAS_INGEST_TOKEN\s*=\s*(.*)$/.exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

const TOKEN = token();
if (!TOKEN) { no("CANVAS_INGEST_TOKEN is not set — run: node bin/minami-setup.mjs"); process.exit(1); }

// The sentence is deliberately code-switched: it is the case that actually breaks, so a pre-flight
// that used clean English would pass on a day the real thing would fail.
const LINE = "Chốt lại là mình sẽ deploy cái workflow lên server vào thứ sáu, anh Alex lo phần vector search.";
const TERMS = ["deploy", "workflow", "vector search"];

const dir = join(tmpdir(), "minami-preflight");
mkdirSync(dir, { recursive: true });
const aiff = join(dir, "p.aiff");
const wav = join(dir, "p.wav");

try {
  console.log(dim("      synthesising a code-switched utterance…"));
  execFileSync("say", ["-v", "Linh", "-o", aiff, LINE], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", aiff, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { stdio: "ignore" });
} catch {
  no("could not synthesise audio — is ffmpeg installed? (brew install ffmpeg)");
  process.exit(1);
}

const meetingId = `preflight-${Date.now()}`;
const audio = readFileSync(wav).toString("base64");

const post = (path, body, ms = 180000) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });

let failed = false;
const t0 = Date.now();
let res;
try {
  res = await post("/api/canvas/ingest", { meetingId, speaker: "Pre-flight", speechMs: 8000, totalMs: 12000, audio, format: "wav" });
} catch (e) {
  no(`ingest unreachable — ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
const heard = await res.json().catch(() => ({}));
if (!res.ok || heard.ok === false) { no(`ingest refused: ${heard.error ?? res.status}`); process.exit(1); }
if (!heard.heard) { no("the ear returned nothing for real speech — check CANVAS_STT_MODEL"); failed = true; }
else ok(`heard in ${((heard.sttMs ?? 0) / 1000).toFixed(1)}s ${dim(`(${heard.speaker})`)}`);

// The judge runs off the response path, so the card lands after the POST returns.
let cards = 0, board = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  board = await fetch(`${BASE}/api/canvas?meeting=${encodeURIComponent(meetingId)}`, { cache: "no-store" })
    .then((r) => r.json()).catch(() => null);
  cards = (board?.nodes ?? []).filter((n) => n.kind !== "topic").length;
  if (cards) break;
}

if (cards) {
  const labels = (board.nodes ?? []).filter((n) => n.kind !== "topic").map((n) => n.label);
  ok(`judged in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${cards} card(s)`);
  console.log(dim(`      "${labels[0]}"`));
  // Terminology is the thing that silently regresses when a model or a vocabulary changes.
  const all = labels.join(" ").toLowerCase();
  const kept = TERMS.filter((t) => all.includes(t.toLowerCase()));
  if (kept.length) ok(`kept English terms: ${kept.join(", ")}`);
  else console.log(`  \x1b[33m!\x1b[0m ${dim("no English terms survived — the ear may be on the wrong model")}`);
} else {
  no("no card appeared within 30s — the judge is failing or stalled");
  failed = true;
}

// Close it out so the test board does not sit in memory next to a real meeting.
try { await post("/api/canvas/ingest", { meetingId, event: "end" }, 30000); } catch { /* best effort */ }
try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

if (typeof heard.costSoFar === "number") console.log(dim(`      cost: $${heard.costSoFar.toFixed(4)}`));
process.exit(failed ? 1 : 0);
