#!/usr/bin/env node
// RECALL RECEIVER — the audio leg of "Minami joins the meeting".
//
//   Google Meet → Recall bot → wss:// here → utterance chunks → the canvas pipeline
//
// Runs on the Hetzner box (Singapore, ~70ms from Recall's ap-northeast-1), NOT on the Mac. A laptop
// that sleeps is a bad audio sink, and the box is already up for Minami.
//
// ── What this deliberately is not ────────────────────────────────────────────────────────────────
// It is not a Next.js route. Recall pushes over a websocket and Next's route handlers don't serve
// those — and more importantly this must keep running when the dashboard is rebuilt. A meeting is not
// interruptible; `bin/serve.sh` swapping the app underneath it must not cost you the call.
//
// ── The one property this gives up ──────────────────────────────────────────────────────────────
// Minami is Socket Mode precisely so it needs no inbound ports. This needs one — Recall connects TO
// us. A Cloudflare named tunnel is how that is repaid: a stable public wss:// hostname with the
// Hetzner firewall still closed to everything but SSH. Nothing here listens on a public interface.
//
//   cloudflared tunnel --url http://localhost:8787
//   node server/recall-receiver.mjs
//
// Env:
//   RECALL_RECEIVER_PORT   default 8787
//   RECALL_RECEIVER_TOKEN  if set, Recall's URL must carry ?token=… — see authorize() below
//   CANVAS_INGEST_URL      where chunks go, e.g. http://localhost:3000/api/canvas/ingest
//   CANVAS_INGEST_TOKEN    bearer token for that endpoint

import { createWsServer } from "./ws-min.mjs";
import { createChunker, wav, BYTES_PER_MS } from "./utterance-chunker.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.RECALL_RECEIVER_PORT || 8787);
const TOKEN = process.env.RECALL_RECEIVER_TOKEN || "";
const OPEN = process.env.RECALL_RECEIVER_OPEN === "1";
const INGEST = process.env.CANVAS_INGEST_URL || "";
const INGEST_TOKEN = process.env.CANVAS_INGEST_TOKEN || "";
/** Set to a directory to keep every utterance as a .wav. Off by default — this is real meeting audio,
 *  and the whole retention story is that we do not store it. Turn it on deliberately, for tuning. */
const DUMP = process.env.CANVAS_DUMP_DIR || "";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let stats = { events: 0, chunks: 0, bytes: 0, unnamed: 0, failed: 0, startedAt: Date.now() };

/** Depth-first hunt for the two fields that matter, wherever Recall nests them.
 *
 *  Written against a probe of the real envelope rather than the docs, and kept tolerant on purpose:
 *  the shape is the vendor's to change, and a receiver that hard-codes a path breaks silently in the
 *  middle of a meeting rather than loudly at deploy time. */
function findAudio(node, out = { buffer: null, participant: null, botId: null }, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === "buffer" && typeof v === "string" && !out.buffer) out.buffer = v;
    else if (k === "participant" && v && typeof v === "object" && !out.participant) out.participant = v;
    // Recall's envelope carries `bot: { id }`. That id IS the meeting identity, and it is the same id
    // bin/minami-meet.mjs uses to close the session — see the note on `meetingId` in send().
    else if (k === "bot" && v && typeof v === "object" && typeof v.id === "string" && !out.botId) out.botId = v.id;
    else findAudio(v, out, depth + 1);
  }
  return out;
}

/** Ship one utterance to the pipeline.
 *
 *  Failure here must never stop the meeting: a dropped chunk costs a few seconds of board, a thrown
 *  exception costs the whole call. So it logs and moves on — the next utterance is seconds away, and
 *  the transcript is not the durable record anyway. */
async function send(chunk) {
  stats.chunks++;
  stats.bytes += chunk.pcm.length;
  if (!chunk.speaker) stats.unnamed++;

  // Report the TRIM, not just the duration. "sent 3.7s of a 15.0s window" is the single most useful
  // line in this log: it says at a glance whether speech detection is working, and it is exactly the
  // number that was silently wrong for a whole meeting.
  const sent = (chunk.totalMs / 1000).toFixed(1);
  const raw = ((chunk.rawMs ?? chunk.totalMs) / 1000).toFixed(1);
  log(
    `chunk  ${(chunk.speaker ?? "«unnamed»").padEnd(18)} sent ${sent}s of ${raw}s window ` +
    `(${(chunk.speechMs / 1000).toFixed(1)}s speech, ${chunk.reason})`,
  );

  if (DUMP) {
    try {
      mkdirSync(DUMP, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}_${(chunk.speaker || "unknown").replace(/\s+/g, "-")}.wav`;
      writeFileSync(join(DUMP, name), wav(chunk.pcm));
    } catch (e) { log(`  dump failed: ${e.message}`); }
  }

  if (!INGEST) return; // dry run: prove the audio leg before wiring the models to it

  try {
    const res = await fetch(INGEST, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(INGEST_TOKEN ? { authorization: `Bearer ${INGEST_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        // ⚠️ WITHOUT THIS EVERY MEETING SHARES ONE BOARD.
        //
        // The ingest route keys sessions on `meetingId` and falls back to "default" when it is
        // absent — which it always was. So every utterance from every meeting accumulated into one
        // session, two concurrent meetings would have shown each other's cards, and the launcher's
        // end-of-meeting event (which correctly targets the bot id) closed a session that had never
        // existed, making the summary permanently empty and leaking the real one.
        //
        // Recall puts the bot id in every audio frame, so identity is already on the wire.
        meetingId: chunk.meetingId ?? chunker?.meetingId ?? null,
        speaker: chunk.speaker,
        email: chunk.email,
        speechMs: Math.round(chunk.speechMs),
        totalMs: Math.round(chunk.totalMs),
        // WAV rather than mp3: Recall already delivers exactly what the STT endpoint wants, so this
        // is a 44-byte header instead of an ffmpeg subprocess per utterance.
        audio: wav(chunk.pcm).toString("base64"),
        format: "wav",
      }),
    });
    if (!res.ok) { stats.failed++; log(`  ingest ${res.status}: ${(await res.text()).slice(0, 140)}`); }
  } catch (e) {
    stats.failed++;
    log(`  ingest failed: ${e.message.slice(0, 140)}`);
  }
}


/** One chunker PER CONNECTION, not one per process.
 *
 *  A module-level chunker is shared by every bot that connects, so two concurrent meetings would
 *  interleave their per-participant buffers, and either one disconnecting would flush the other's
 *  half-finished utterances. Nothing about that fails loudly. */
let chunker = null;

createWsServer({
  port: PORT,
  // Anyone who finds the tunnel hostname can otherwise push audio into your meeting pipeline. A
  // shared token in the query string is what Recall's realtime_endpoints URL can actually carry.
  // FAIL CLOSED, same as /api/canvas/ingest. This was `!TOKEN || …`, so forgetting the token opened
  // the socket rather than shutting it. This port is reachable through the same Cloudflare tunnel as
  // the app, and what arrives on it is live meeting audio — the one input that must never accept an
  // anonymous peer. Opening it takes a deliberate RECALL_RECEIVER_OPEN=1.
  authorize: (req) => {
    if (!TOKEN) return OPEN;
    return new URL(req.url, "http://x").searchParams.get("token") === TOKEN;
  },
  onOpen: () => {
    stats = { events: 0, chunks: 0, bytes: 0, unnamed: 0, failed: 0, startedAt: Date.now() };
    chunker = createChunker(send);
    log("bot connected");
  },
  onClose: () => {
    // Flush before reporting: the last thing said in a meeting is often the thing worth keeping.
    chunker?.end();
    chunker = null;
    const mins = ((Date.now() - stats.startedAt) / 60000).toFixed(1);
    log(`bot disconnected — ${mins} min, ${stats.events} events, ${stats.chunks} chunks, ` +
        `${(stats.bytes / BYTES_PER_MS / 1000).toFixed(0)}s audio, ${stats.unnamed} unnamed, ${stats.failed} failed`);
  },
  onMessage: (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    stats.events++;
    const { buffer, participant, botId } = findAudio(msg);
    if (!buffer || !chunker) return;
    // The id travels with the chunk so `send()` can label it without reaching for shared state.
    chunker.meetingId = botId ?? chunker.meetingId ?? null;
    chunker.push(participant, Buffer.from(buffer, "base64"));
  },
});

log(`recall-receiver on :${PORT}${TOKEN ? " (token required)" : OPEN ? " (OPEN — RECALL_RECEIVER_OPEN=1)" : " (REFUSING ALL — set RECALL_RECEIVER_TOKEN)"}`);
log(INGEST ? `forwarding to ${INGEST}` : "DRY RUN — no CANVAS_INGEST_URL, chunks logged only");
