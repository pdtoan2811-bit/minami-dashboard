#!/usr/bin/env node
// MINAMI JOINS A MEETING — one command, both directions.
//
//   node bin/minami-meet.mjs https://meet.google.com/abc-defg-hij
//
// Sends a Recall bot that does two things at once:
//
//   IN   per-participant audio → the receiver → /api/canvas/ingest → cards
//   OUT  the canvas page, screen-shared back into the meeting as the bot's video
//
// The second half is what makes this a product rather than a notetaker: the room watches the board
// draw itself while they talk, instead of reading a summary afterwards.
//
// ── Two settings here are decisions, not defaults ───────────────────────────────────────────────
//
//   retention: null    Recall's DEFAULT IS "forever". Verified on a real bot 2026-08-12 — the first
//                      test recording was retained until it was explicitly deleted. `null` is zero
//                      data retention: nothing is ever stored on their servers. Enforcing it at
//                      creation is the only version of "audio is never stored" that survives someone
//                      forgetting to run the cleanup.
//
//   variant web_4_core The default `web` bot has 250 millicores and 750MB. It cannot render this
//                      canvas, and separate-participant audio wants the bigger box anyway. One
//                      setting, two reasons.
//
// The bot renders the page at 1280x720 @ 15fps. Anything sized for a laptop screen is unreadable
// after that re-encode — which is also why the canvas animations are slow: slow motion survives a
// 15fps stream, fast motion judders.

import { checkBudget, recordMeeting } from "../server/canvas-budget.mjs";

const MEET = process.argv[2];
const KEY = process.env.RECALL_API_KEY;
const REGION = process.env.RECALL_REGION || "ap-northeast-1";
const RECEIVER = process.env.RECALL_RECEIVER_URL || "";
/** A saved meeting shape to start from — see server/canvas-templates.mjs. Chosen in the launcher. */
const TEMPLATE = process.env.CANVAS_MEETING_TEMPLATE || "";   // wss://…  (the tunnel to recall-receiver)
const CANVAS = process.env.RECALL_CANVAS_URL || "";       // https://… (the tunnel to /canvas)
const INGEST = process.env.CANVAS_INGEST_URL || "";
const INGEST_TOKEN = process.env.CANVAS_INGEST_TOKEN || "";
const RECEIVER_TOKEN = process.env.RECALL_RECEIVER_TOKEN || "";

/** PRESENT LOCALLY — `--present`, or CANVAS_PRESENT_LOCAL=1.
 *
 *  The bot joins for AUDIO ONLY and you share the canvas yourself as a Chrome tab. Four things follow
 *  from that, and only the first is the one anh asked for:
 *
 *   1. RESOLUTION STOPS BEING RECALL'S DECISION. 1280x720 @ 15fps is their cap on every variant,
 *      web_gpu included. A tab you share goes out at the tab's real size.
 *   2. IT FIXES THE LAG. SSE does not survive a Cloudflare quick tunnel, which is why the canvas has
 *      a 6-second polling fallback and why the board felt behind the conversation. Rendered locally,
 *      SSE works and the board repaints the moment the judge returns.
 *   3. THE APP NO LONGER NEEDS TO BE PUBLIC. RECALL_CANVAS_URL exists solely so Recall's browser can
 *      load /canvas. Without it, only the audio receiver is exposed — and that one is token-gated.
 *   4. NO BROWSER TO RENDER, so the bot does not need web_4_core's extra cores and memory.
 *
 *  The trade: anh has to be at the machine and share the tab each call, and the canvas leaves with
 *  anh. That is why --share is kept for meetings anh is not driving. */
const PRESENT = process.argv.includes("--present") || process.env.CANVAS_PRESENT_LOCAL === "1";

/** What this call is about, from `--context "…"`. Sent to ingest before the bot joins, so the judge
 *  has the subject in hand for the very first chunk rather than inferring it from hello-how-are-you. */
const CONTEXT = (() => {
  const i = process.argv.indexOf("--context");
  return i > -1 ? (process.argv[i + 1] ?? "") : (process.env.CANVAS_MEETING_CONTEXT ?? "");
})();

if (!MEET || !KEY) {
  console.error("usage: RECALL_API_KEY=… node bin/minami-meet.mjs <meet-url> [--present]");
  console.error("  --present   bot joins for audio only; YOU share the canvas tab at full resolution");
  console.error("env: RECALL_REGION RECALL_RECEIVER_URL CANVAS_INGEST_URL [RECALL_CANVAS_URL if not --present]");
  process.exit(1);
}

const api = (path, init = {}) =>
  fetch(`https://${REGION}.recall.ai/api/v1${path}`, {
    ...init,
    headers: { Authorization: `Token ${KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── BUDGET GATE ─────────────────────────────────────────────────────────────────────────────────
// Checked BEFORE the bot is created, because refusing to dispatch is the only refusal that costs
// nothing. Once a bot is in a room it is billing whether or not anyone is watching the number.
const budget = checkBudget();
if (!budget.ok) {
  log(`REFUSED: ${budget.reason}`);
  log("Raise CANVAS_BUDGET_USD or wait for the month to roll over.");
  process.exit(4);
}
if (budget.warn) log(`⚠ budget: ${budget.warn}`);

/** The receiver's URL with its shared secret attached.
 *
 *  Appended here rather than pasted into RECALL_RECEIVER_URL by hand, because the two must agree and a
 *  mismatch fails in the least helpful way available: the bot joins, the meeting looks fine, and the
 *  websocket is refused — so the board simply never fills and nothing says why. Deriving it from the
 *  same env var the receiver reads makes disagreement impossible. */
const receiverUrl = (() => {
  if (!RECEIVER) return "";
  if (!RECEIVER_TOKEN) return RECEIVER;
  const u = new URL(RECEIVER);
  u.searchParams.set("token", RECEIVER_TOKEN);
  return u.toString();
})();

const recording_config = {
  // Zero data retention — see the note above. This is the whole of "audio is never stored".
  retention: null,
  ...(receiverUrl
    ? {
        audio_separate_raw: {},
        realtime_endpoints: [{ type: "websocket", url: receiverUrl, events: ["audio_separate_raw.data"] }],
      }
    : {}),
};

/** The URL the bot actually loads.
 *
 *  `?broadcast=1` switches the canvas into the mode built for a 1280x720 @ 15fps re-encode: ambient
 *  animation off, bigger and darker type, thicker strokes, no dot grid. Resolution and framerate are
 *  fixed by the meeting platform and Recall exposes no control over either, so the only lever on
 *  quality is what gets rendered — and the biggest win is not spending the encoder's bitrate on
 *  motion nobody asked for. */
const canvasUrl = PRESENT || !CANVAS ? "" : `${CANVAS}${CANVAS.includes("?") ? "&" : "?"}broadcast=1`;

/** Where to open the board. Derived from the ingest URL rather than a new env var, because the app
 *  that serves /canvas is by definition the app that serves /api/canvas/ingest. */
const localCanvas = (() => {
  // NOT ?live=1 — that is the OPERATOR view, and it carries the model pipeline, the cost panel and
  // the run controls down the right-hand side. The bot never showed it because the bot loads plain
  // ?broadcast=1; a shared TAB shows whatever is in the tab. Pointing anh at ?live=1 would have put
  // Minami's internals on screen in front of whoever is in the call.
  try { return `${new URL(INGEST).origin}/canvas?present=1`; }
  catch { return "http://localhost:3010/canvas?present=1"; }
})();

const body = {
  meeting_url: MEET,
  bot_name: "Minami",
  // web_4_core buys the cores and memory needed to RENDER the canvas. An audio-only bot renders
  // nothing, so the default `web` (250 millicores, 750MB) is the honest size of the job.
  variant: { google_meet: PRESENT ? "web" : "web_4_core" },
  recording_config,
  // SCREENSHARE, NOT CAMERA — and this is the single biggest quality decision in the file.
  //
  // Both paths render at exactly 1280x720 @ 15fps; Recall caps every variant there, including
  // `web_gpu`, so the resolution is theirs and not Google's. What differs is how the platform TREATS
  // the track:
  //
  //   camera      encoded as a face. Motion-optimised, small tile, low bitrate priority, and the
  //               encoder smooths fine high-frequency detail — which is precisely what text is. A
  //               board full of 15px type sent down the camera path arrives as grey mush.
  //   screenshare encoded as CONTENT. Sharp-edge preserving, given the large tile and the bitrate
  //               priority a presentation gets, and it drops framerate before it drops detail —
  //               exactly the trade anh asked for, made by the platform on our behalf.
  //
  // Same pixels in, very different pixels out. The docs only ever show `camera` in their examples;
  // `screenshare` was confirmed by probing the API — it echoes back intact, while an invented key is
  // silently dropped to {}.
  ...(canvasUrl
    ? { output_media: { [process.env.RECALL_OUTPUT_MODE || "screenshare"]: { kind: "webpage", config: { url: canvasUrl } } } }
    : {}),
};

// Seed BEFORE wiping is pointless and seeding after is required — the reset clears the board.
// (the seed POST lives just below the reset)

// WIPE THE BOARD FIRST. The canvas is in-memory and survives between meetings, so without this the
// room's first sight of Minami is the last meeting's cards — or worse, the demo board. Done before
// the bot is created so the page is already empty by the time it loads.
if (INGEST) {
  try {
    const base = new URL(INGEST);
    base.pathname = "/api/canvas";
    base.search = "?reset=1";
    await fetch(base, { method: "POST" });
    log("board reset");
  } catch {
    log("could not reset the board — it may open on the previous meeting");
  }

  // AFTER the reset, or it would be wiped by it.
  if (CONTEXT) {
    try {
      const r = await fetch(INGEST, {
        method: "POST",
        headers: { "content-type": "application/json", ...(INGEST_TOKEN ? { authorization: `Bearer ${INGEST_TOKEN}` } : {}) },
        body: JSON.stringify({ meetingId: "pending", event: "seed", context: CONTEXT, template: TEMPLATE }),
      });
      const d = await r.json().catch(() => null);
      log(`context: ${CONTEXT.slice(0, 70)}${d?.topic ? `  → topic "${d.topic}"` : ""}`);
    } catch {
      log("could not seed the meeting context — the board will infer its own topics");
    }
  }
}

log(`joining ${MEET}`);
log(`  audio  → ${RECEIVER || "(none — bot will not stream audio)"}${RECEIVER && RECEIVER_TOKEN ? "  [token ✓]" : RECEIVER ? "  [NO TOKEN — receiver is open]" : ""}`);
log(`  canvas → ${PRESENT ? "YOU present it locally (--present)" : canvasUrl || "(none — bot will not share a screen)"}${!PRESENT && canvasUrl ? `  [${process.env.RECALL_OUTPUT_MODE || "screenshare"}]` : ""}`);

const res = await api("/bot", { method: "POST", body: JSON.stringify(body) });
const bot = await res.json();

/** ⚠️ LEAVE THE CALL ON ANY EXIT, not only the happy one.
 *
 *  leave_call and delete_media sat at the very bottom of this file, reachable only after the poll
 *  loop returned normally. Every other way this process ends — Ctrl-C, closing the Terminal window
 *  (SIGHUP), the launcher's cleanup trap sending SIGTERM, an unhandled rejection — skipped them and
 *  left a bot sitting in the room at $0.50/hr until Recall's own automatic_leave noticed.
 *
 *  The launcher's own documented way to quit ("Ctrl-C, or close the window") was therefore the
 *  reliable way to abandon a paid bot: it tore down every free local service and left the billed one
 *  running. Registered here, immediately after the id exists, because before this line there is
 *  nothing to leave and after it there always is. */
let leaving = false;
const leaveNow = async (why) => {
  if (leaving) return;
  leaving = true;
  log(`${why} — asking the bot to leave`);
  try { await api(`/bot/${bot.id}/leave_call/`, { method: "POST" }); } catch (e) { log(`leave failed: ${e.message}`); }
  try { await api(`/bot/${bot.id}/delete_media/`, { method: "POST" }); } catch { /* retention is null anyway */ }
  process.exit(130);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => void leaveNow(sig));
// An unhandled rejection used to kill the process silently; the bot outlived it.
process.on("unhandledRejection", (e) => void leaveNow(`unhandled: ${String(e).slice(0, 80)}`));
if (!res.ok) {
  console.error("create failed:", JSON.stringify(bot).slice(0, 600));
  process.exit(1);
}
log(`bot ${bot.id}`);
log("waiting for someone to ADMIT it…");

// Poll rather than webhook: this is a foreground command you watch, and a webhook would need yet
// another public endpoint for something that lives for the length of one meeting.
let last = "";
let inCall = false;
let pollFails = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));

  // A transient socket close used to kill this process outright — `TypeError: fetch failed /
  // UND_ERR_SOCKET: other side closed`, mid-meeting, taking the end-of-meeting passes with it. One
  // failed poll says nothing about the meeting; the bot is running on Recall's infrastructure, not
  // here. Only a sustained outage is worth giving up on.
  let b;
  try {
    b = await (await api(`/bot/${bot.id}`)).json();
    pollFails = 0;
  } catch (e) {
    if (++pollFails >= 12) { log(`lost contact with Recall (${e.message}) — giving up`); break; }
    continue;
  }

  const code = b.status_changes?.at(-1)?.code ?? "?";
  if (code !== last) {
    log(`status: ${code}${b.status_changes?.at(-1)?.sub_code ? ` (${b.status_changes.at(-1).sub_code})` : ""}`);
    if (code === "in_call_recording" && !inCall) {
      inCall = true;
      if (!PRESENT) log("  ✓ in the room, audio flowing, canvas shared");
      else {
        // The bot is listening but NOTHING is on screen until anh shares. Said at the moment it
        // becomes true, not at startup, so it is not scrolled away by twenty lines of status polling.
        log("  ✓ in the room, audio flowing — NOTHING IS SHARED YET, this part is yours:");
        log(`     1. open   ${localCanvas}`);
        log("     2. Meet → Present now → A tab → pick that tab → Share");
        log("     3. leave the tab open; a tab being captured keeps rendering even behind other windows");
      }
    }
    last = code;
  }
  if (code === "done" || code === "fatal") break;
}

// The meeting is over, so the passes that read the WHOLE board can run — they were kept off the hot
// path precisely so they could happen here, with nobody waiting.
if (INGEST) {
  try {
    const r = await fetch(INGEST, {
      method: "POST",
      headers: { "content-type": "application/json", ...(INGEST_TOKEN ? { authorization: `Bearer ${INGEST_TOKEN}` } : {}) },
      body: JSON.stringify({ meetingId: bot.id, event: "end" }),
    });
    const { summary } = await r.json();
    if (summary) {
      log(`meeting over — ${summary.minutes} min, ${summary.utterances} utterances, ` +
          `${summary.cards} cards, ${summary.topics} topics, $${summary.cost}`);
      // Bot time plus model spend, booked once the duration is actually known.
      const after = recordMeeting({ minutes: summary.minutes, modelUsd: summary.cost });
      log(`month to date: $${after.usd.toFixed(2)} across ${after.meetings} meeting(s)`);
      if (summary.archived) log(`archived → ${summary.archived}`);
      else log("NOT ARCHIVED — the meeting left no durable record");
    }
  } catch (e) {
    log(`could not close the session: ${e.message}`);
  }
}

// Belt and braces. retention:null should mean there is nothing to delete, so a failure here is
// expected and harmless — it is worth the one call to be certain rather than to assume.
/** ASK IT TO LEAVE, don't wait to be evicted.
 *
 *  Nothing here ever told the bot to go — it left only when Recall's own automatic_leave fired or the
 *  room emptied. If anh hangs up while anyone else is still in the call, the bot stays in an empty-ish
 *  room and keeps billing at $0.50/hr until that timer decides. One request closes it. A failure is
 *  fine and expected when it has already gone, which is why the status is logged rather than checked. */
const bye = await api(`/bot/${bot.id}/leave_call/`, { method: "POST" });
log(`leave call: ${bye.status}${bye.status === 200 ? " (left)" : " (already gone)"}`);

const del = await api(`/bot/${bot.id}/delete_media/`, { method: "POST" });
log(`media delete: ${del.status}${del.status === 200 ? " (nothing retained)" : " (nothing to delete)"}`);
