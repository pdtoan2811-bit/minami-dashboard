#!/usr/bin/env node
// Transcript-loading benchmark (§1). What a chat pane actually downloads, per chat, for the three
// requests it makes: the FIRST load, a poll when NOTHING changed, and a slim first load. Run it before
// and after a change to the transcript route and compare the JSON it writes.
//
//   node bin/bench-transcripts.mjs [--base http://localhost:3000] [--n 8] [--label baseline] [--out file.json]
//
// It mimics lib/session-fetch.ts: the idle poll sends `slim=1&since=<last turn's off>&size=<size the
// last response reported>`. A server that predates those params ignores them and returns the full
// window, which is exactly the baseline behaviour being measured.
import fs from "node:fs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("base", "http://localhost:3000");
const N = Number(arg("n", "8"));
const LABEL = arg("label", "run");
const OUT = arg("out", "");

async function timed(url) {
  const t0 = performance.now();
  const r = await fetch(url, { headers: { "accept-encoding": "identity" } });
  const buf = Buffer.from(await r.arrayBuffer());
  const ms = performance.now() - t0;
  let body = null;
  try { body = JSON.parse(buf.toString("utf8")); } catch { /* not json */ }
  return { bytes: buf.length, ms: Math.round(ms * 10) / 10, body };
}

const list = await (await fetch(`${BASE}/api/bento/sessions`)).json();
const sessions = (Array.isArray(list) ? list : list.sessions || []).sort((a, b) => b.lastActivity - a.lastActivity).slice(0, N);
const rows = [];
for (const s of sessions) {
  const url = `${BASE}/api/bento/session/${s.id}`;
  const full = await timed(url);
  const slim = await timed(`${url}?slim=1`);
  const turns = full.body?.turns || [];
  const lastOff = turns.at(-1)?.off;
  const size = slim.body?.size ?? full.body?.size;
  const idle = await timed(`${url}?slim=1${lastOff != null ? `&since=${lastOff}` : ""}${size != null ? `&size=${size}` : ""}`);
  rows.push({ id: s.id.slice(0, 8), title: (s.task || s.title || "").slice(0, 40), turns: turns.length, fullBytes: full.bytes, fullMs: full.ms, slimBytes: slim.bytes, idlePollBytes: idle.bytes, idlePollMs: idle.ms });
}
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
const result = { label: LABEL, at: new Date().toISOString(), base: BASE, rows, totals: { fullBytes: sum("fullBytes"), slimBytes: sum("slimBytes"), idlePollBytes: sum("idlePollBytes") } };

const kb = (b) => (b >= 1024 * 1024 ? `${(b / 1048576).toFixed(2)} MB` : `${(b / 1024).toFixed(1)} KB`);
console.log(`\n${LABEL} — ${BASE} — ${rows.length} most recent chats`);
console.log("chat      turns   first load    slim load    idle poll   (poll every 2.5s per open pane)");
for (const r of rows) console.log(`${r.id}  ${String(r.turns).padStart(5)}  ${kb(r.fullBytes).padStart(11)}  ${kb(r.slimBytes).padStart(11)}  ${kb(r.idlePollBytes).padStart(11)}`);
console.log(`TOTAL           ${kb(result.totals.fullBytes).padStart(11)}  ${kb(result.totals.slimBytes).padStart(11)}  ${kb(result.totals.idlePollBytes).padStart(11)}`);
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n"); console.log(`→ ${OUT}`); }
