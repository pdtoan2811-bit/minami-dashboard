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
import { createChunker, wav, normalisePcm, BYTES_PER_MS } from "./utterance-chunker.mjs";
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

/** How many consecutive ingest failures before this stops being a blip and starts being an outage. */
const LOUD_AFTER = 3;
let consecutiveFails = 0;

/** Ship one utterance to the pipeline.
 *
 *  Failure here must never stop the meeting: a thrown exception costs the whole call. So it logs and
 *  moves on — the next utterance is seconds away.
 *
 *  ⚠️ BUT IT MUST TRY MORE THAN ONCE, AND IT MUST GET LOUD.
 *
 *  This used to be a single un-retried, un-timed-out fetch whose only trace was one grey line reading
 *  `ingest failed: fetch failed`. On 2026-08-19 the app on :3011 degraded (a trivial GET took 3.8s)
 *  and 48 consecutive chunks died exactly that way — a whole stretch of a real meeting, gone, while
 *  the log scrolled past at the same cadence as a healthy one and the canvas simply stopped growing.
 *
 *  This audio is the ONLY copy of what was said. It is not like a dropped frame; there is nothing to
 *  re-render it from. So: a bounded retry with backoff, an explicit timeout so a wedged server cannot
 *  hold the socket open indefinitely, and a shout on the third consecutive failure — because the one
 *  thing the old line never conveyed was "this is not one chunk, this is all of them". */
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

  // Built once and reused across attempts: re-encoding 200KB of base64 per retry is wasteful, and a
  // retry must send byte-identical audio anyway.
  const body = JSON.stringify(bodyFor(chunk));
  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // Generous but finite. A judge chain can legitimately hold a request for tens of seconds; a
    // wedged socket must not hold it forever.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45_000);
    try {
      const res = await fetch(INGEST, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "content-type": "application/json",
          ...(INGEST_TOKEN ? { authorization: `Bearer ${INGEST_TOKEN}` } : {}),
        },
        body,
      });
      if (res.ok) {
        if (consecutiveFails >= LOUD_AFTER) log(`  ✓ ingest recovered after ${consecutiveFails} lost chunk(s)`);
        consecutiveFails = 0;
        return;
      }
      const text = (await res.text()).slice(0, 140);
      // 4xx is OUR bug — a bad body, a wrong token, an ended meeting. Retrying cannot help and would
      // only bury the real message under two more copies of it.
      if (res.status < 500) { stats.failed++; noteFailure(`ingest ${res.status}: ${text}`); return; }
      if (attempt === ATTEMPTS) { stats.failed++; noteFailure(`ingest ${res.status} after ${ATTEMPTS} attempts: ${text}`); return; }
      log(`  ingest ${res.status}, retrying (${attempt}/${ATTEMPTS})`);
    } catch (e) {
      const why = e?.name === "AbortError" ? "timed out after 45s" : String(e?.message ?? e).slice(0, 140);
      if (attempt === ATTEMPTS) { stats.failed++; noteFailure(`ingest failed after ${ATTEMPTS} attempts: ${why}`); return; }
      log(`  ingest failed (${why}), retrying (${attempt}/${ATTEMPTS})`);
    } finally {
      clearTimeout(timer);
    }
    // Backoff, so a server that is merely saturated gets a moment to breathe rather than three
    // near-simultaneous copies of the request that saturated it.
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
}

/** Shout when failures stop being isolated. A per-chunk line is invisible in a log that already
 *  prints a line per chunk; "NOTHING HAS REACHED THE CANVAS FOR N CHUNKS" is not. */
function noteFailure(msg) {
  consecutiveFails++;
  log(`  ${msg}`);
  if (consecutiveFails === LOUD_AFTER || (consecutiveFails > LOUD_AFTER && consecutiveFails % 5 === 0)) {
    log("");
    log(`  ⚠⚠ NOTHING HAS REACHED THE CANVAS FOR ${consecutiveFails} CHUNKS — the board is frozen.`);
    log(`  ⚠⚠ Target: ${INGEST}`);
    log(`  ⚠⚠ Check that the meeting app is up and healthy on that port. Audio is being LOST.`);
    log("");
  }
}

/** The request body for one utterance. Split out of send() so a retry re-sends byte-identical audio
 *  without rebuilding 200KB of base64 each time. */
/** How loud an utterance may be made before it reaches the ear.
 *
 *  2.0 is anh's own number ("150% to 200%"). It is a CEILING, not a setting: the gain actually used
 *  is measured per chunk, so a loud utterance is left alone. Lower it if amplified room noise ever
 *  becomes the problem instead. */
const MIC_GAIN_MAX = Number(process.env.CANVAS_MIC_GAIN_MAX || 2.0);

function bodyFor(chunk) {
  /** ⚠️ APPLIED HERE, ONCE, ON THE WAY OUT. Not in the chunker, because the chunker's speech
   *  detection is calibrated against the levels Recall actually sends and would start seeing speech
   *  in amplified silence. The ear gets the loud copy; every decision about what counts as speech is
   *  still made on the original. */
  const boosted = normalisePcm(chunk.pcm, { maxGain: MIC_GAIN_MAX });
  if (boosted.gain > 1.01) {
    stats.boosted = (stats.boosted ?? 0) + 1;
    log(`  gain x${boosted.gain.toFixed(2)} (peak ${boosted.peakBefore.toFixed(2)} → ${boosted.peakAfter.toFixed(2)})`);
  }
  return {
    // ⚠️ WITHOUT THIS EVERY MEETING SHARES ONE BOARD.
    //
    // The ingest route keys sessions on `meetingId` and falls back to "default" when it is absent —
    // which it always was. So every utterance from every meeting accumulated into one session, two
    // concurrent meetings would have shown each other's cards, and the launcher's end-of-meeting
    // event (which correctly targets the bot id) closed a session that had never existed, making the
    // summary permanently empty and leaking the real one.
    //
    // Recall puts the bot id in every audio frame, so identity is already on the wire.
    meetingId: chunk.meetingId ?? chunker?.meetingId ?? null,
    speaker: chunk.speaker,
    email: chunk.email,
    speechMs: Math.round(chunk.speechMs),
    totalMs: Math.round(chunk.totalMs),
    // WAV rather than mp3: Recall already delivers exactly what the STT endpoint wants, so this is a
    // 44-byte header instead of an ffmpeg subprocess per utterance.
    audio: wav(boosted.pcm).toString("base64"),
    format: "wav",
    // Reported so the trace can show it. If this is pinned at the ceiling every chunk, the microphone
    // is the thing to fix and no amount of software will do it as well.
    gain: +boosted.gain.toFixed(2),
  };
}


/** One chunker PER CONNECTION, not one per process.
 *
 *  A module-level chunker is shared by every bot that connects, so two concurrent meetings would
 *  interleave their per-participant buffers, and either one disconnecting would flush the other's
 *  half-finished utterances. Nothing about that fails loudly. */
let chunker = null;

createWsServer({
  // "ok" only when this receiver can actually forward — see ws-min for why.
  health: () => (INGEST ? "ok" : "dry-run"),
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
