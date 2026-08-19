#!/usr/bin/env node
// Recall.ai audio probe — does the vendor actually deliver what the docs claim?
//
// Answers exactly four questions, before a line of pipeline code is written against it:
//   1. does per-participant audio arrive at all?
//   2. is it really 16 kHz mono S16LE, i.e. 32,000 bytes per second per speaker?
//   3. does every chunk carry a REAL name (the whole reason we chose Recall over diarization)?
//   4. how long from someone speaking to the bytes landing here?
//
// Zero dependencies on purpose. This has to run before anyone decides to install anything, and a
// probe that needs a build step is a probe nobody runs.
//
//   node bin/recall-probe.mjs 8787
//
// Then point a Recall bot's realtime_endpoints url at wss://<your-tunnel>/ and start talking.

import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.argv[2] || 8787);

/** 16 kHz × 1 channel × 2 bytes (S16LE). The claim under test: bytes/BYTES_PER_SECOND == seconds. */
const BYTES_PER_SECOND = 16000 * 2;

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const speakers = new Map(); // name -> { bytes, chunks, first, last, email }
let started = 0;
let events = 0;
let unnamed = 0;

// ── WebSocket, by hand ────────────────────────────────────────────────────────
// Recall connects TO us, so every frame it sends is masked (RFC 6455 §5.1) and must be unmasked
// before it is JSON. Large payloads also arrive as continuation frames, which is easy to forget
// and presents as "the JSON is truncated sometimes" rather than as a framing bug.

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("recall-probe: alive. point a wss:// realtime endpoint here.\n");
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${createHash("sha1").update(key + GUID).digest("base64")}\r\n\r\n`,
  );

  console.log(`\n  ✓ websocket connected from ${req.socket.remoteAddress}\n`);
  started ||= Date.now();

  let buf = Buffer.alloc(0);
  let fragOp = 0;
  let frags = [];

  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);

    for (;;) {
      if (buf.length < 2) return;

      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        // Payloads above 2^53 are not a thing here; Number() keeps the arithmetic readable.
        len = Number(buf.readBigUInt64BE(off));
        off += 8;
      }

      let mask;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4);
        off += 4;
      }

      if (buf.length < off + len) return; // frame still in flight

      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);

      if (opcode === 0x8) { socket.end(); return; }          // close
      if (opcode === 0x9) { pong(socket, payload); continue; } // ping
      if (opcode === 0xa) continue;                            // pong

      if (opcode === 0x0) frags.push(payload);
      else { fragOp = opcode; frags = [payload]; }

      if (!fin) continue;

      const message = Buffer.concat(frags);
      frags = [];
      if (fragOp === 0x1) onMessage(message.toString("utf8"));
    }
  });

  socket.on("error", (e) => console.error("  socket error:", e.message));
  socket.on("close", () => console.log("\n  websocket closed\n"));
});

function pong(socket, payload) {
  const head = Buffer.from([0x8a, payload.length]); // probe-scale payloads only
  socket.write(Buffer.concat([head, payload]));
}

// ── What Recall actually sent ─────────────────────────────────────────────────
// The exact nesting of the event envelope is the thing we are here to LEARN, so nothing below
// hardcodes a path into it. Walk the object, find a base64 buffer and a participant, report what
// was really there. Guessing the shape would make the probe agree with the docs by construction.

function onMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { console.log("  non-JSON frame:", text.slice(0, 200)); return; }

  events++;
  if (events === 1) {
    console.log("  first event envelope (keys only):", JSON.stringify(shape(msg), null, 1), "\n");
  }

  const found = { buffer: null, participant: null };
  walk(msg, found);

  if (!found.buffer) {
    console.log(`  event: ${msg.event ?? "?"} (no audio buffer)`);
    return;
  }

  const bytes = Buffer.from(found.buffer, "base64").length;
  const name = found.participant?.name ?? null;
  if (!name) unnamed++;

  const who = name ?? `«unnamed id=${found.participant?.id ?? "?"}»`;
  const s = speakers.get(who) ?? { bytes: 0, chunks: 0, first: Date.now(), email: found.participant?.email ?? null };
  s.bytes += bytes;
  s.chunks++;
  s.last = Date.now();
  speakers.set(who, s);

  if (s.chunks === 1) {
    console.log(`  ► first audio from ${who}  (+${((Date.now() - started) / 1000).toFixed(1)}s)  email=${s.email ?? "—"}`);
  }
}

/** Depth-first hunt for the two fields that matter, wherever Recall chose to put them. */
function walk(node, out, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "buffer" && typeof v === "string" && !out.buffer) out.buffer = v;
    else if (k === "participant" && v && typeof v === "object" && !out.participant) out.participant = v;
    else walk(v, out, depth + 1);
  }
}

/** Key skeleton of an object — enough to see the envelope without dumping base64 audio. */
function shape(node, depth = 0) {
  if (Array.isArray(node)) return depth > 3 ? "[…]" : [shape(node[0], depth + 1)];
  if (!node || typeof node !== "object") return typeof node;
  if (depth > 3) return "{…}";
  const o = {};
  for (const [k, v] of Object.entries(node)) {
    o[k] = k === "buffer" ? `<base64 ${String(v).length} chars>` : shape(v, depth + 1);
  }
  return o;
}

// ── The verdict ───────────────────────────────────────────────────────────────

function report() {
  const wall = started ? (Date.now() - started) / 1000 : 0;
  console.log(`\n─── probe report ─── ${events} events over ${wall.toFixed(1)}s\n`);

  if (!speakers.size) {
    console.log("  NO AUDIO RECEIVED. Check: tunnel reachable over wss, realtime_endpoints.url set,");
    console.log("  events includes 'audio_separate_raw.data', bot actually admitted to the meeting.\n");
    return;
  }

  console.log("  speaker                     chunks     bytes    audio-s   avg chunk");
  for (const [name, s] of speakers) {
    const secs = s.bytes / BYTES_PER_SECOND;
    console.log(
      `  ${name.padEnd(26).slice(0, 26)} ${String(s.chunks).padStart(6)} ${String(s.bytes).padStart(9)} ` +
        `${secs.toFixed(1).padStart(9)} ${(secs / s.chunks).toFixed(2).padStart(10)}s`,
    );
  }

  const total = [...speakers.values()].reduce((a, s) => a + s.bytes, 0);
  console.log(`\n  → ${(total / BYTES_PER_SECOND).toFixed(1)}s of audio across ${speakers.size} speaker(s).`);
  console.log(`  → naming: ${unnamed === 0 ? "every chunk named ✓" : `${unnamed} chunk(s) had NO name ✗`}`);
  console.log("  → if audio-s tracks wall clock, the 16 kHz mono S16LE claim holds.\n");
}

process.on("SIGINT", () => { report(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`\n  recall-probe listening on :${PORT}`);
  console.log(`  expose it:  cloudflared tunnel --url http://localhost:${PORT}`);
  console.log(`  then use the https URL as wss:// in realtime_endpoints.`);
  console.log(`  Ctrl-C for the report.\n`);
});
