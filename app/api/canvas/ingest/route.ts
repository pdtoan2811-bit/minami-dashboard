// LIVE INGEST — one utterance from a Recall bot becomes cards on the board.
//
//   Google Meet → Recall → server/recall-receiver.mjs → POST here → /api/canvas → the bot's screen
//
// The counterpart to /api/canvas/live, which reads an mp3 off disk for the A/B harness. Both share
// lib/canvas-board.ts, so a rule bought with a bug on the test path applies here too.
//
// ── Three things this does differently from the file path ───────────────────────────────────────
//
// 1. IT KNOWS WHO SPOKE. Recall streams a separate channel per participant with their roster name
//    attached — proven on a real Meet 2026-08-12, diacritics intact. No diarization, no inference.
//    The transcript therefore carries real names, which is the one thing OpenRouter could not give
//    us at any price.
//
// 2. NO CHUNK PLANNING. The receiver already cut on the speaker's own pauses, so an utterance
//    arrives whole. There is nothing to slice and no overlap to pay for.
//
// 3. STATE LIVES BETWEEN REQUESTS. The file path builds a board inside one long-lived SSE handler;
//    here every utterance is a separate HTTP request, so the board is held per meeting on
//    globalThis — same reason the transcript caches live there, a dev hot-reload must not orphan a
//    meeting in progress.
//
// ── What is deliberately NOT here ───────────────────────────────────────────────────────────────
// No relate pass. It reads the whole board at once and belongs at the END of a meeting.
// The TIDY pass now runs continuously in the background (see TIDY_EVERY) — it is the counterweight
// that makes judging every utterance affordable, and it had never once run during a meeting.

import { deriveActions, glossaryFrom, interpretRequest, noSpend, refineBoard, transcribe, warmUpCards, type RawAction } from "@/lib/canvas-llm";
import { createBoard, type Board } from "@/lib/canvas-board";
import { resolveMode } from "@/lib/canvas-modes";
// Plain ESM helper, shared with the standalone receiver which cannot import TS.
import { archiveMeeting } from "@/server/canvas-archive.mjs";
import { getTemplate } from "@/server/canvas-templates.mjs";
import { asrPrompt, correctLines, loadVocab, saveVocab } from "@/server/canvas-vocab.mjs";
import { parseCommand, describeCommand, applyCommand, addressesMinami, type Command, type CommandHost } from "@/lib/canvas-commands";
import { trace } from "@/lib/canvas-trace";
import { createEntityIndex, type EntityIndex } from "@/server/canvas-entities.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TOKEN = process.env.CANVAS_INGEST_TOKEN || "";

/** ⚠️ FAIL CLOSED. This was `if (TOKEN && ...)` — an unset token skipped the check entirely, so a
 *  MISCONFIGURATION opened the endpoint instead of closing it. That is not theoretical: .env.local
 *  declared CANVAS_INGEST_TOKEN twice, once empty on line 13 and once real on line 35, and dotenv
 *  keeps the FIRST — so the token looked present in the file, the server booted clean, and the
 *  endpoint sat open on a public Cloudflare tunnel. An unauthenticated POST was confirmed accepted.
 *
 *  What that exposed: anyone with the tunnel URL could spend OpenRouter credit on STT and judge
 *  calls, publish arbitrary cards onto the canvas Minami screen-shares INTO a live meeting, and end
 *  and archive a meeting in progress.
 *
 *  Opening it now takes a deliberate CANVAS_INGEST_OPEN=1, which cannot happen by typo or by a dead
 *  line drifting to the top of a file. */
const OPEN = process.env.CANVAS_INGEST_OPEN === "1";
if (!TOKEN && !OPEN) {
  console.error("[ingest] CANVAS_INGEST_TOKEN is unset — refusing every request. Set it, or set CANVAS_INGEST_OPEN=1 for local dev.");
}

/** How much recent transcript anything looks at.
 *
 *  ⚠️ EVERY consumer of the transcript must use a WINDOW, not the whole meeting. Three separate
 *  callers were handed `s.lines` in full, and each one is O(n) per call:
 *
 *    quoteIsGrounded  joins + normalises + Set-builds the ENTIRE transcript, once per proposed card
 *    glossaryFrom     regex-scans every line, twice per utterance
 *
 *  With ~5 cards per utterance and a transcript that grows all meeting, that is O(n²) over the call —
 *  fine for the 60-second test file, and by minute forty it is seconds of blocking CPU per utterance
 *  on a 2-vCPU box, on the same event loop that serves the bot's SSE stream. The board would visibly
 *  stall the longer a meeting ran, which is the worst possible shape for this bug: it passes every
 *  short test and only appears in real use.
 *
 *  There is a correctness reason too, and it is the better argument. Grounding against the whole
 *  meeting lets a card cite something said forty minutes ago and count as evidence for what was just
 *  said. Grounding is supposed to mean "traceable to THIS", and a window is what makes that true. */
const RECENT = 60;

/** The grounding window, in one place — the judge and its fallback must agree on what "recent" means
 *  or a verbatim card could be rejected as ungrounded against a different slice of the transcript. */
const recentLines = (s: { lines: string[] }) => s.lines.slice(-RECENT);

/** How many utterances may be waiting to be judged before we start skipping.
 *
 *  2 is deliberately tight. Utterances arrive roughly every 10s and a judge call takes 2-6s, so a
 *  healthy meeting never reaches this. Reaching it means the model is having a slow spell, and the
 *  right response is to stay current rather than to faithfully render a conversation that has already
 *  moved on. */
/** ⚠️ THIS NUMBER CHANGED MEANING. It was 2 because a queued judge DELAYED every later one, so depth
 *  was latency and had to be tiny. Judges now run concurrently, so this bounds COST and fan-out only
 *  — and at 2 it was throwing away real speech to protect against a queue that no longer exists.
 *  Six concurrent judges at ~3s each is comfortably inside one 10s chunk window. */
const MAX_QUEUED_JUDGES = 6;

/** How long the board may go without gaining a single card before Minami stops trusting the judge and
 *  writes the words down verbatim instead. See the dead-man's switch, below.
 *
 *  Ninety seconds is chosen against how a real meeting reads on a shared screen, not against the
 *  pipeline: a gap that long is the point where anh starts glancing at the canvas instead of talking,
 *  and where the room starts to notice it too. It is also long enough that ordinary quiet — a demo, a
 *  tangent, someone else holding the floor — passes through untouched, because ordinary quiet does not
 *  arrive as forty-five characters of substantive speech chunk after chunk. */
const DEAD_MAN_MS = 90_000;

/** How often the board consolidates itself, in utterances.
 *
 *  ⚠️ THIS NEVER RAN. `refineBoard` has existed for weeks and the live path never called it — the
 *  same class of bug as the reactions: built, wired to nothing. The consequence was measured on a real
 *  meeting: 38 cards under 2 topics, duplicates accumulating for the whole call, because nothing was
 *  ever allowed to merge them.
 *
 *  Judging every utterance is what makes the board feel live, and it is also what produces duplicates
 *  — the judge sees one breath and cannot know the same point was made four minutes ago. Continuous
 *  tidying is the counterweight that makes that trade affordable. Without it, "keep the real-time
 *  feel" and "stop the sprawl" are in direct conflict; with it they are not.
 *
 *  Every 3 utterances is roughly every 30s at the observed cadence. It runs OFF the response path, so
 *  a slow tidy delays nothing a viewer is waiting on. */
const TIDY_EVERY = 3;

type Session = {
  /** This session's meetingId. Carried on the object because publish() receives only the session, and
   *  it needs to say WHICH meeting is taking over the single global board. */
  id: string;
  board: Board;
  /** Speaker-prefixed lines, newest last. Capped — see LINE_CAP. */
  lines: string[];
  startedAt: number;
  /** Bumped on every request, so an abandoned meeting can be swept. */
  touchedAt: number;
  utterances: number;
  cost: number;
  /** Set the moment the meeting ends. Async work in flight checks this before touching the board. */
  ended: boolean;
  /** Every ear that actually transcribed something in this call.
   *
   *  ⚠️ NOT the configured default. The ear can be switched mid-meeting from the dock, and it has
   *  been — repeatedly, while working out which model could hold Vietnamese with English terms. A
   *  board archived with "the default was gemini" would be a record of the config, not of what
   *  produced these cards. This is a Set because two ears in one meeting is a real thing that
   *  happens, and the honest answer is then both. */
  ears?: Set<string>;
  /** The thinking models in use, recorded when the first chunk is judged.
   *
   *  Read at `end`, where `mode` is not yet in scope — and taken from the session rather than
   *  re-resolved so an A/B arm chosen for this meeting is what gets recorded, not whatever the
   *  default happens to be by the time it finishes. */
  derive?: { judge: string; tidy: string; relate: string };
  /** Judges currently talking to the model, mapped to WHEN they started. They no longer share a
   *  queue, so `end` drains this rather than the chain — see the note on head-of-line blocking. The
   *  timestamp is what makes the backlog gate self-healing; see JUDGE_CEILING_MS. */
  inflight: Map<Promise<unknown>, number>;
  /** Topic set by voice ("Minami, chủ đề mới: …"), so later cards hang under it. */
  topic?: string;
  /** What this call is ABOUT, given before it starts — a line anh typed or a Second Brain project he
   *  picked. Handed to every judge call so the first topic is the real subject rather than whatever
   *  the opening small talk happened to be about. */
  context?: string;
  /** A spoken "tidy" waiting for the next utterance to run it on the chain. */
  forceTidy?: boolean;
  /** Ear chosen mid-call. Overrides CANVAS_STT_MODEL for THIS meeting only — the env default is what
   *  the next call starts from, so an experiment cannot silently become the permanent setting. */
  stt?: string;
  /** Language pin for this meeting: "vi", "en", or "" for auto-detect. */
  sttLang?: string;
  /** The template this call started from, if any — recorded so the archive can say so. */
  template?: string;
  /** Set by "tắt meme" or the dock toggle. Memes are anh's own curation, but a room can still turn
   *  out to be the wrong one — a client joins late, a call turns serious. */
  memesOff?: boolean;
  /** Several people sharing one microphone — see TranscribeEngine.room. */
  room?: boolean;
  /** Names discovered in the room so far, fed back so labels stay stable between chunks. */
  roster?: string[];
  /** Set by the canvas "listen" button: until this moment, speech is read as a command with no wake
   *  word required. See app/api/canvas/control/route.ts for why a button beats a spoken name. */
  commandUntil?: number;
  /** Corrections scoped to THIS call only — they die with the session and never touch the vault-
   *  synced vocabulary file. */
  fixes?: Record<string, string>;
  /** Judge calls waiting on the chain. Bounded — see MAX_QUEUED_JUDGES. */
  queued: number;
  dropped: number;
  /** Who and what this meeting is about, resolved across mishearings. */
  entities: EntityIndex;
  /** Serialises judging per meeting. Each judge call needs the board as it stood after the previous
   *  one, and two utterances landing together would otherwise both propose the same topic and both
   *  create it. Transcription is NOT serialised — it does not touch the board. */
  chain: Promise<unknown>;
  /** When the board last actually gained a card. The dead-man's switch reads this — see DEAD_MAN_MS. */
  lastCardAt: number;
};

/** Meetings in flight. On globalThis so a Next hot-reload in dev doesn't strand a live call. */
const store: Map<string, Session> =
  (globalThis as { __canvasSessions?: Map<string, Session> }).__canvasSessions ??
  ((globalThis as { __canvasSessions?: Map<string, Session> }).__canvasSessions = new Map());

/** Transcript kept in memory. Enough for the end-of-meeting summary to be useful, bounded so a
 *  three-hour call cannot grow without limit. The durable record is the vault note, not this. */
const LINE_CAP = 4000;

/** A meeting with no traffic for this long is over, however it ended. */
const SESSION_TTL_MS = 45 * 60 * 1000;

/** Meetings that have ENDED and been archived.
 *
 *  `session()` creates on miss, and `end` deletes — so ANY request arriving after `end` silently
 *  built a second, empty session under the same id. That is not hypothetical: when the bot leaves,
 *  the receiver flushes its final buffered audio (`chunker.end()`) at socket close, while the
 *  launcher POSTs `end` as soon as its status poll sees `done`. Those two race, and the poll often
 *  wins. The resurrected session then paid for STT and a judge call on a meeting that was over,
 *  published a near-empty board OVER the finished one on the canvas, and sat in memory until the
 *  45-minute sweep — with an archive already written, so nothing it produced was ever saved.
 *
 *  A tombstone is the id alone, not the board, so remembering costs a string for one TTL. */
const ENDED = new Map<string, number>();
const TOMBSTONE_MS = 10 * 60 * 1000;

function sweep() {
  // Sessions were only ever removed by an explicit `event: "end"`. Every other ending — the bot
  // crashing, the launcher dying mid-poll (which happened, on a transient socket error), a meeting
  // simply abandoned — leaked a board and a full transcript for the lifetime of the process. On a
  // 4 GB box shared with the Slack bot that is not theoretical.
  const now = Date.now();
  for (const [id, s] of store) {
    if (now - s.touchedAt > SESSION_TTL_MS) {
      console.warn(`[ingest] sweeping abandoned meeting ${id} (idle ${Math.round((now - s.touchedAt) / 60000)}m)`);
      store.delete(id);
    }
  }
  for (const [id, at] of ENDED) if (now - at > TOMBSTONE_MS) ENDED.delete(id);
}

function session(id: string): Session {
  sweep();
  let s = store.get(id);
  if (!s) {
    s = {
      id, board: createBoard(), lines: [], startedAt: Date.now(), touchedAt: Date.now(), inflight: new Map(),
      utterances: 0, cost: 0, ended: false, queued: 0, dropped: 0, chain: Promise.resolve(), topic: undefined,
      entities: createEntityIndex(loadVocab()), lastCardAt: Date.now(),
    };
    store.set(id, s);
  }
  s.touchedAt = Date.now();
  return s;
}

/** Push the board to /api/canvas, which fans it out over SSE to every viewer — including the browser
 *  the Recall bot is screen-sharing. Failure is logged, never thrown: a dropped frame costs one
 *  repaint, a thrown error costs the meeting. */
async function publish(req: Request, s: Session, title?: string) {
  // Last line of defence: an ended meeting must never be repainted as live, no matter which in-flight
  // caller gets here. The end path publishes its own status:"ended" frame before deleting the session.
  if (s.ended) return;
  /** ⚠️ ONLY OVERRIDE THE TITLE IF THERE REALLY IS ONE. Every caller passed `body.title || "Meeting"`,
   *  so the literal English word was handed to graph() on every publish and won over the board's own
   *  language-aware title — the language switch fired correctly, logged correctly, and the board still
   *  said "Meeting" over entirely Vietnamese cards. Passing undefined lets the board decide. */
  const graph = s.board.graph({
    ...(title ? { title } : {}),
    subtitle: `${s.utterances} utterances · ${s.board.cards().length} cards`,
    memes: !s.memesOff,
  });
  /** Every frame says who it belongs to. The server keys boards on this, and a viewer pins itself to
   *  the first meeting it sees — together that is what stops one meeting's screen-share from ever
   *  rendering another's cards. Previously this was a single global document and they did exactly
   *  that: confirmed twice on 2026-08-19, once by a stray probe and once by two bots in one room. */
  graph.meetingId = s.id;
  try {
    const r = await fetch(new URL("/api/canvas", req.url), {
      method: "POST",
      headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
      body: JSON.stringify(graph),
    });
    /** ⚠️ A NON-2xx HERE USED TO BE INVISIBLE. fetch only rejects on a transport failure, so on the day
     *  /api/canvas gained auth and the internal callers had not yet been handed the token, every publish
     *  "succeeded": no throw, no log, a healthy-looking ingest, and a board that simply never changed.
     *  That was "I am running one, but nothing created or shown". The status is checked now, and the
     *  failure goes both to the log and to the debug panel on the canvas. */
    if (!r.ok) {
      const why = `publish rejected — HTTP ${r.status}${r.status === 401 ? " (internal call is missing the ingest token)" : ""}`;
      trace("error", why);
      console.error(`[ingest] ${why}`);
    } else {
      trace("paint", `board published — ${s.board.cards().length} cards`);
    }
  } catch (e) {
    trace("error", `publish failed — ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
    console.error("[ingest] publish failed:", e instanceof Error ? e.message : e);
  }
}

export async function POST(req: Request) {
  if (!TOKEN && !OPEN) {
    return Response.json({ ok: false, error: "ingest token not configured" }, { status: 503 });
  }
  if (TOKEN && req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: {
    meetingId?: string; speaker?: string | null; audio?: string; format?: string; context?: string;
    speechMs?: number; totalMs?: number; event?: string; title?: string;
    /** Gain the receiver applied before sending — see normalisePcm. */
    gain?: number;
    /** Start from a saved meeting shape — see server/canvas-templates.mjs. */
    template?: string;
  };
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }); }

  const id = body.meetingId || "default";

  // Late audio from the receiver's final flush lands here AFTER the archive is written. Dropping it
  // is the correct outcome — the alternative is paying to transcribe it into a board nobody will
  // ever see. Logged rather than silent, because a LOT of these would mean the flush is racing badly.
  /** ⚠️ `end` MUST BE IDEMPOTENT. It was exempt from the tombstone so a late end could still close a
   *  meeting — but session() creates on miss, and the first end had already deleted the session. So a
   *  DUPLICATE end (the dock's disconnect plus the launcher's poll, or one double-click) built a
   *  brand-new empty session, archived a second folder reading "Nothing was captured", booked a
   *  0.0-minute meeting, and PUBLISHED that empty board — blanking the screen anh was sharing at the
   *  exact moment the meeting ended. */
  if (ENDED.has(id) && body.event === "end" && !store.has(id)) {
    return Response.json({ ok: true, ignored: "already ended" });
  }
  if (ENDED.has(id) && body.event !== "end") {
    console.log(`[ingest] ignoring ${body.audio ? "late audio" : "late event"} for ended meeting ${id}`);
    return Response.json({ ok: true, ignored: "meeting ended" });
  }

  const s = session(id);

  // ── end of meeting ────────────────────────────────────────────────────────────────────────────
  // The bot leaving is the signal to stop, not a timeout. Everything expensive that reads the whole
  // board at once happens here, once, when nobody is waiting on it.
  /** SEED — sent once, before the first word. Sets the subject the judge should name topics after,
   *  and opens the board with that topic so the very first card has somewhere sensible to land. */
  if (body.event === "seed") {
    /** ⚠️ A SEED ON A SESSION THAT NEVER STARTED MEANS A RELAUNCH — START CLEAN.
     *
     *  The launcher seeds under the id "pending", because the real meeting id is Recall's bot id and
     *  does not exist until the bot connects. So every launch attempt lands on the SAME session, and
     *  a failed attempt leaves its board behind for the next one to inherit.
     *
     *  Observed 2026-08-21: a dead tunnel meant no audio ever arrived, anh relaunched three times, and
     *  the board he finally saw held fifteen warm-up ghosts — three copies of the same five — with
     *  zero utterances behind them. A canvas full of things nobody had said.
     *
     *  Zero utterances is the safe test: a session that has heard nothing has nothing worth keeping,
     *  so this can never discard a real meeting. One that HAS heard something is left alone. */
    if (s.utterances === 0 && s.board.cards().length) {
      const dropped = s.board.cards().length;
      s.board = createBoard();
      s.entities = createEntityIndex();
      s.lines = [];
      console.log(`[ingest] relaunch on an unstarted session — cleared ${dropped} leftover card(s)`);
      trace("skip", `relaunch: cleared ${dropped} card(s) from an attempt that never started`);
    }
    /** A TEMPLATE IS A HAND-MADE WARM-UP. It seeds the backbone the judge hangs things under —
     *  "agenda nó khá là rõ… nó cứ pick từ đấy nó đỡ bị lạc". Topics are REAL, not ghosts: anh chose
     *  them deliberately before the call, which is exactly the difference between a template and the
     *  AI's guess at one. */
    const tpl = body.template ? getTemplate(String(body.template)) : null;
    if (tpl) {
      for (const t of tpl.topics) s.board.topicId(t);
      s.template = tpl.name;
      console.log(`[ingest] template "${tpl.name}": ${tpl.topics.length} topics`);
    }
    const ctx = (body.context || "").trim().slice(0, 400);
    if (ctx) {
      s.context = ctx;
      // The first line is treated as the headline subject; anything after it is background.
      const head = ctx.split(/[\n.·—-]/)[0]?.trim();
      if (head && head.length > 1 && head.length <= 60) {
        s.topic = head;
        s.board.topicId(head);
      }
      console.log(`[ingest] seeded: ${ctx.slice(0, 80)}`);
      await publish(req, s, undefined);
      /** WARM-UP. Off the response path: the launcher is waiting on this call to dispatch a bot, and
       *  a board that opens two seconds later is worth nothing next to a call that starts two seconds
       *  later. If it fails or is slow, the board simply opens empty exactly as before. */
      void warmUpCards(ctx, { cfg: resolveMode(null).derive })
        .then(async (labels) => {
          if (!labels.length || s.ended) return;
          // Only ever onto a board nobody has spoken into yet — a late warm-up must not appear
          // underneath real cards that have already landed.
          if (s.board.cards().some((c) => !("placeholder" in c) || !c.placeholder)) return;
          const n = s.board.seedPlaceholders(labels, s.topic ? s.board.topicId(s.topic) : undefined);
          if (n) { console.log(`[ingest] warm-up: ${n} placeholder card(s)`); await publish(req, s, undefined); }
        })
        .catch(() => {});
    }
    return Response.json({ ok: true, seeded: ctx || null, topic: s.topic ?? null });
  }

  if (body.event === "end") {
    // Close the session BEFORE anything else. A tidy pass may be in flight; without this it would
    // finish, mutate a board that has already been archived, and publish it — putting a finished
    // meeting back on the live canvas after the record was written.
    s.ended = true;
    ENDED.set(id, Date.now());

    // ⚠️ DRAIN BEFORE ARCHIVING. The archive used to be taken synchronously, the instant `end`
    // arrived — but up to MAX_QUEUED_JUDGES judges can still be mid-flight, each holding cards for
    // the last utterances of the call. They finished a second later and mutated a board that was
    // already on disk, so the durable record was systematically missing the END of every meeting:
    // exactly where the decisions and the agreements are. Nothing logged, nothing failed; the notes
    // were simply short.
    //
    // Bounded, because `end` must not hang on a wedged provider call. Past the bound we archive what
    // we have and say so — a slightly short record beats a meeting that never closes and never books
    // its cost. The queued tidy returns immediately on `s.ended`, so this normally waits on a judge.
    // ⚠️ DRAIN BOTH. Judges left the chain when head-of-line blocking was removed, so awaiting
    // `s.chain` alone would archive a board while the last few utterances were still being judged —
    // silently reintroducing the "record is missing the end of every meeting" bug this drain exists
    // to prevent.
    const drained = await Promise.race([
      Promise.all([s.chain.catch(() => {}), ...[...s.inflight.keys()].map((p) => p.catch(() => {}))]).then(() => true).catch(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 20_000)),
    ]);
    if (!drained) console.warn(`[ingest] archiving ${id} with work still in flight (20s drain elapsed)`);
    else if (s.queued > 0) console.log(`[ingest] drained ${s.queued} in-flight judge(s) before archiving`);

    const minutes = +((Date.now() - s.startedAt) / 60000).toFixed(1);
    // ⚠️ STRIPPED FROM THE RECORD. A ghost that survives into the archive becomes indistinguishable
    // from something that was said — and the archive is what the vault, the notes and anh's memory
    // are all built on. They were never content; they must not become history.
    s.board.clearPlaceholders();
    const graph = s.board.graph({ ...(body.title ? { title: body.title } : {}), status: "ended" });

    // THE DURABLE RECORD. Until this existed a meeting produced a live board and nothing you could
    // read the next morning — the canvas is in-memory by design and dies with the call.
    const archived = archiveMeeting({
      meetingId: id,
      /** WHAT MADE THIS BOARD. Recorded per meeting because the answer changes: the ear has moved
       *  between whisper, qwen, Blaze and an omni model, and a board is only comparable with another
       *  board if you know which produced it. Reading an archive six weeks later and being unable to
       *  say what heard it is how a model regression goes unnoticed. */
      models: {
        ears: [...(s.ears ?? [])],
        judge: s.derive?.judge ?? null,
        tidy: s.derive?.tidy ?? null,
        relate: s.derive?.relate ?? null,
        language: s.sttLang ?? null,
        room: !!s.room,
      },
      title: body.title || "Meeting",
      startedAt: s.startedAt,
      minutes,
      graph,
      transcript: s.lines,
      cost: +s.cost.toFixed(4),
    });

    const summary = {
      utterances: s.utterances,
      cards: s.board.cards().length,
      topics: s.board.topicNames().length,
      edges: s.board.edges.length,
      minutes,
      cost: +s.cost.toFixed(4),
      archived,
      transcript: s.lines,
    };
    /** ⚠️ TELL THE SCREEN IT IS OVER. The ended graph was built, archived and then dropped — the
     *  canvas kept rendering the last LIVE frame, so a finished meeting sat on a shared screen
     *  showing "Live · Listening" indefinitely. Verified after a real call: status was still "live"
     *  eight minutes after the bot had gone. Publishing here is the only moment that knows. */
    try {
      await fetch(new URL("/api/canvas", req.url), {
        method: "POST",
        headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
        body: JSON.stringify(graph),
      });
    } catch (e) {
      console.error("[ingest] final publish failed:", e instanceof Error ? e.message : e);
    }

    store.delete(id);
    return Response.json({ ok: true, ended: true, summary });
  }

  if (!body.audio) return Response.json({ ok: false, error: "expected { audio } base64" }, { status: 400 });

  /** ⚠️ A NEAR-SILENT CHUNK MUST NOT REACH A MODEL. Flagged repeatedly through the day and finally
   *  earned: the chunker already measures speech, and windows carrying 0.4-0.8s of it were being sent
   *  anyway. Handed almost nothing, a generative ear fills the gap from whatever context it has — the
   *  glossary-as-fake-meeting failure — and even a well-behaved ASR returns filler the judge then
   *  turns into cards nobody said.
   *
   *  1.2s is below any real sentence and above a cough. It also stops paying for them: at chat-model
   *  rates a silent chunk is not free. */
  const MIN_SPEECH_MS = Number(process.env.CANVAS_MIN_SPEECH_MS || 1200);
  if (typeof body.speechMs === "number" && body.speechMs < MIN_SPEECH_MS) {
    console.log(`[ingest] skipping a near-silent chunk (${body.speechMs}ms of speech)`);
    trace("skip", `near-silent chunk — ${body.speechMs}ms of speech, below the ${MIN_SPEECH_MS}ms floor`);
    return Response.json({ ok: true, skipped: "too little speech", speechMs: body.speechMs });
  }

  const audio = Buffer.from(body.audio, "base64");
  const speaker = body.speaker?.trim() || null;
  const mode = resolveMode(null);
  const spend = noSpend();

  // ── hear ──────────────────────────────────────────────────────────────────────────────────────
  // THE VOCABULARY, APPLIED AT BOTH ENDS.
  //
  // Before: known terms are sent as a decoding prompt, so the model can produce "Minami" instead of
  // guessing at a name it has never heard. After: known mishearings are rewritten, because biasing
  // reduces errors and never eliminates them — three different ASR models all produced "my mask" for
  // "mind map", and no amount of prompting fixes a word the decoder simply does not know.
  //
  // The order matters downstream: correction happens BEFORE the judge sees anything, so the cards,
  // the topic names, the archive and the email all inherit the corrected text. That is the whole
  // point. "Minamino" became the topic name of an entire board because the raw transcript was what
  // got judged.
  const vocab = loadVocab();
  const glossary = glossaryFrom(s.lines.slice(-RECENT));

  let heard: string[];
  /** ⚠️ START THE CLOCK BEFORE THE EAR, NOT AFTER IT.
   *
   *  This used to be declared below the try/catch, so `sttMs` measured the gap between transcription
   *  FINISHING and the judge being queued — a few hundred microseconds of local work. It reported
   *  `stt=1ms` for a six-second clip, and the "slower than real time" warning it feeds could never
   *  fire, because 1ms is never greater than a 10s chunk. The one number that would have shown the ear
   *  degrading from 3.5s to 20s during "it stales" was structurally incapable of showing it. */
  const tHeard = Date.now();
  try {
    /** THE EAR CAN CHANGE MID-CALL. `mode.transcribe` is resolved from env at module load, so it is
     *  the same object for every meeting; overriding a copy keeps this call's choice out of the next
     *  one. Language is part of the choice, not a separate setting — the reason to switch ears is
     *  usually the reason to change the pin (Vietnamese-heavy vs English-heavy). */
    const roomOpt = s.room ? { room: { known: s.roster ?? [] } } : {};
    const ear = s.stt || s.sttLang !== undefined || s.room
      ? { ...mode.transcribe, ...(s.stt ? { model: s.stt } : {}), ...(s.sttLang !== undefined ? { language: s.sttLang || undefined } : {}), ...roomOpt }
      : mode.transcribe;
    (s.ears ??= new Set()).add(ear.model);
    s.derive ??= { judge: mode.derive.model, tidy: mode.derive.tidyModel, relate: mode.derive.relateModel };
    const r = await transcribe(
      ear,
      audio,
      glossary,
      spend,
      body.format || "wav",
      asrPrompt(vocab, glossary),
    );
    // PER-CALL FIXES LAYERED OVER THE UNIVERSAL ONES. Session fixes win, because anh typed them in
    // this meeting about this meeting — a name corrected by hand thirty seconds ago is better evidence
    // than a rule learned last week.
    const scoped = s.fixes ? { ...vocab, fixes: { ...vocab.fixes, ...s.fixes } } : vocab;
    const { corrected, changes } = correctLines(r.lines, scoped);
    // Logged, never silent: a correction layer nobody can see is one nobody can trust, and this line
    // is how a NEW mishearing gets noticed and taught.
    for (const c of changes) {
      console.log(`[vocab] "${c.from}" → "${c.to}"`);
      trace("correct", `"${c.from}" → "${c.to}"`);
    }

    // ── ENTITY RESOLUTION ────────────────────────────────────────────────────────────────────────
    // Learn from this utterance, then rewrite it. Order matters: observing first means a name first
    // heard correctly in THIS line can immediately fix a mangled version later in the same line.
    //
    // This runs BEFORE the judge, so the board is built from resolved names — which is the whole
    // point. "Minamino" became a topic name because the judge read the raw text.
    for (const l of corrected) s.entities.observe(l);
    heard = corrected.map((l) => s.entities.rewrite(l));
    for (let i = 0; i < heard.length; i++) {
      if (heard[i] !== corrected[i]) console.log(`[entity] "${corrected[i]}" → "${heard[i]}"`);
    }
  } catch (e) {
    // One failed utterance is a few seconds of board, not a broken meeting. The next one is seconds
    // away and the receiver has already moved on.
    trace("error", `transcribe failed — ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
    console.error("[ingest] transcribe failed:", e instanceof Error ? e.message : e);
    return Response.json({ ok: false, error: "transcribe failed" }, { status: 502 });
  }
  if (!heard.length) {
    // Worth a line. A run of these means the ASR is returning nothing for real audio — which has
    // happened twice, and both times the only visible symptom was a board that stopped growing.
    console.log(`[ingest] ${speaker ?? "?"}: transcript empty, nothing to judge`);
    return Response.json({ ok: true, skipped: "no speech" });
  }

  /** ⚠️ RE-CHECK AFTER THE AWAIT. transcribe() takes seconds, and the launcher POSTs `end` the moment
   *  its poll sees `done`. A chunk that entered before the end returned after it, then pushed lines,
   *  queued a judge on a chain the end had already drained, mutated the archived board, and published
   *  with the default status "live" — flipping a finished meeting's shared screen back to
   *  "Live · Listening", with those cards never archived. `s` was captured before the delete, so
   *  store.delete() could not prevent it. */

  /** Book the ASR spend NOW, before any early return. Three paths below — "no speech", a
   *  commands-only utterance, and a judge-backlog skip — returned before the old accounting line, so
   *  a successful, already-paid transcription was never counted. That was noise at whisper's
   *  $0.09/hr; the omni ear bills at chat-model rates and it is not. */
  s.cost += spend.cost;

  if (s.ended) {
    console.log(`[ingest] discarding a chunk that finished transcribing after the meeting ended`);
    return Response.json({ ok: true, ignored: "meeting ended" });
  }

  // ── VOICE COMMANDS, BEFORE THE JUDGE ─────────────────────────────────────────────────────────
  // A command is an instruction ABOUT the board. Judged as content it becomes a card describing the
  // request instead of obeying it — and anh only reaches for a command when the automatic path has
  // already failed him, so getting it wrong twice is the worst possible outcome.
  //
  // Split rather than filtered: a command line is REMOVED from what the judge sees, so "Minami, ghi
  // lại: giá $50" produces exactly one card saying "giá $50" rather than that plus a card about
  // someone asking to note a price.
  // The canvas button opens a window in which the wake word is OPTIONAL: anh already declared intent
  // by clicking, so requiring him to also be heard saying a proper noun re-introduces the exact
  // failure the button exists to route around.
  const armed = !!s.commandUntil && Date.now() < s.commandUntil;
  const commands: Command[] = [];
  const plain: string[] = [];
  /** Addressed Minami, matched no verb. These get a second, semantic reading below. */
  const unrecognised: string[] = [];
  for (const line of heard) {
    const c = parseCommand(line) ?? (armed ? parseCommand(`Minami ${line}`) : null);
    if (c) {
      commands.push(c);
      console.log(`[command]${armed ? " (armed)" : ""} ${describeCommand(c)}`);
      trace("command", `${armed ? "" : "(unarmed) "}${describeCommand(c)}`);
    } else {
      // Still transcript either way — a request is also something that was said, and the judge may
      // legitimately make a card from it.
      plain.push(line);
      if (addressesMinami(line)) unrecognised.push(line);
    }
  }

  /** ⚠️ SPOKEN TO, NOT UNDERSTOOD — the case that used to be silence.
   *
   *  The verb table matches a fixed list of openings, so anything phrased differently fell through as
   *  though nobody had spoken: "thỉnh thoảng thì nó bắt được". Worse, a vocabulary you must recite is
   *  a vocabulary you must PERFORM in front of a client — "cái hệ thống command có vẻ nó hơi lộ".
   *
   *  So a line that clearly addressed Minami and matched nothing gets read for INTENT instead. Off
   *  the response path, like the judge, for the same reason: this must never be why a chunk is slow.
   *  It applies to the live board when it lands, which is a second or two later — the same latency a
   *  card already has. */
  if (unrecognised.length) {
    const line = unrecognised[unrecognised.length - 1];
    void interpretRequest(line, {
      cfg: mode.derive, spend,
      topics: s.board.topicNames(),
      cards: s.board.cards().map((c) => c.label),
    })
      .then(async (raw) => {
        if (!raw || s.ended) return;
        const c = raw as unknown as Command;
        const host: CommandHost = s as unknown as CommandHost;
        const said = applyCommand(host, c, (from, to) => { s.fixes = { ...(s.fixes ?? {}), [from.toLowerCase()]: to }; });
        console.log(`[command] (understood) ${said}`);
        trace("command", `understood: ${said}`);
        await publish(req, s, body.title);
      })
      .catch(() => { /* an unread request is exactly what it was before */ });
  }
  // One click, one command. Leaving the window open would turn the rest of the sentence — and the
  // rest of the meeting's small talk — into commands.
  if (armed && commands.length) s.commandUntil = undefined;

  // On the SESSION, not a local: a "tidy" command usually arrives on its own, and the commands-only
  // path below returns before the tidy block is ever reached. A local would be set and then thrown
  // away — the one command that exists purely to trigger a tidy would be the one that never did.
  let forceTidy = s.forceTidy ?? false;
  for (const c of commands) {
    // ONE applier, shared with the dock — see lib/canvas-commands.ts. A second copy here is how the
    // two paths would quietly diverge the first time a command was added to only one of them.
    applyCommand(s as unknown as CommandHost, c, (f, to) => {
      vocab.fixes[f.toLowerCase()] = to;
      saveVocab(vocab);
    });
    if (c.kind === "tidy") forceTidy = true;
  }

  // Commands alone still repaint — otherwise the one thing anh did by hand is the one thing he cannot
  // see happen, and he has no way to tell it worked.
  if (commands.length && !plain.length) {
    // Carried forward rather than dropped. The next utterance is seconds away and runs the real tidy
    // block, which is already correctly serialised on s.chain — re-implementing it here would be a
    // second copy of the one piece of code that must never race the judge.
    s.forceTidy = forceTidy;
    await publish(req, s, body.title);
    return Response.json({ ok: true, commands: commands.length, tidyQueued: forceTidy, cards: s.board.cards().length });
  }
  heard = plain;

  /** Vietnamese is unambiguous in writing: the tone-marked vowels and đ exist in no other language
   *  anh speaks. One line carrying them is enough — this is a language SIGNAL, not a ratio, and
   *  waiting for a majority would leave the board English through the opening minutes. */
  if (/[àáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(heard.join(" "))) {
    if (s.board.setLanguage("vi")) console.log("[board] language → vi (board labels follow the room)");
  }

  // The name comes from the meeting roster, not from the model. This is the entire reason the stack
  // uses Recall rather than a diarizing ASR: attribution here is identity, not a guess.
  /** ── WHO SAID IT, WHEN EVERYONE SHARES ONE MIC ─────────────────────────────────────────────
   *
   *  Normally the name is free and authoritative: Recall streams one participant per connection, so
   *  `speaker` IS identity, not a guess — which is the whole reason this stack uses Recall rather
   *  than a diarizing ASR. Room mode is the case that breaks: the people around anh are not in the
   *  call, so every voice arrives on his stream under his name.
   *
   *  There the ear returns "<name>: <line>", and the label wins over the Recall roster — it is the
   *  only thing that knows a second person spoke. Anything unlabelled falls back to the participant,
   *  so a mixed reply degrades to today's behaviour rather than losing the line. */
  let said: string[];
  if (s.room) {
    const named: string[] = [];
    for (const line of heard) {
      // ⚠️ NOT EVERY COLON IS A SPEAKER. "http://example.com" parsed as a person called "http" and
      // would have been learned into the roster permanently. A URL scheme is the common case; the
      // guard is cheap and the failure is durable.
      const m = /^\s*([\p{L}][\p{L}\p{N} .'’-]{0,28}?)\s*:\s*(.+)$/u.exec(line);
      if (m && m[2].trim() && !m[2].startsWith("//")) {
        const who = m[1].trim();
        named.push(`${who}: ${m[2].trim()}`);
        // Learn real names only. "Người 2" is a placeholder, not an identity, and feeding it back
        // would freeze the room at its first guess instead of letting a real name replace it.
        if (!/^(người|speaker|nguoi)\s*\d+$/i.test(who)) {
          s.roster = [...new Set([...(s.roster ?? []), who])].slice(0, 12);
        }
      } else {
        named.push(speaker ? `${speaker}: ${line}` : line);
      }
    }
    said = named;
    const fresh = (s.roster ?? []).join(", ");
    if (fresh) console.log(`[room] voices so far: ${fresh}`);
  } else {
    said = speaker ? heard.map((l) => `${speaker}: ${l}`) : heard;
  }
  s.lines.push(...said);
  if (s.lines.length > LINE_CAP) s.lines.splice(0, s.lines.length - LINE_CAP);
  s.utterances++;

  // ── judge ─────────────────────────────────────────────────────────────────────────────────────
  // Chained per meeting so board state is never raced. Awaited so the HTTP response reflects what
  // actually landed — the receiver is sequential per speaker anyway, and back-pressure here is
  // better than a queue we cannot see.
  // ── DON'T LET THE QUEUE COMPOUND ──────────────────────────────────────────────────────────────
  //
  // Judging is serialised per meeting because each call needs the board as it stood after the last
  // one. That is correct and it has a failure mode: if a judge call ever takes longer than the gap
  // between utterances, the backlog grows and NEVER recovers. Measured live 2026-08-13 — the ingest
  // route returned 200 in 60.5s, then 52s, then 44s, then 37s. Those are not slow calls; that is a
  // queue draining, and every card in it was arriving a minute after it was said.
  //
  // So the chain is bounded. When more than this many utterances are already waiting, the OLDEST
  // queued work is skipped rather than run: a card from ninety seconds ago is worth less than the
  // board staying current, and the transcript still records what was said either way.
  /** ⚠️ THE GATE MUST NEVER BE ABLE TO LATCH SHUT. This is the last way a board could still freeze.
   *
   *  The count was a plain counter decremented in a `finally`. That is correct only while every task
   *  eventually settles — and the entire history of this pipeline is things that did not: a provider
   *  holding a socket open, a retry ladder running for minutes, a promise nobody resolved. One leaked
   *  increment and the gate closes for the REST OF THE MEETING, skipping every utterance from then
   *  on, with the board frozen and the logs clean.
   *
   *  So the gate is derived from evidence rather than from bookkeeping: count the judges that started
   *  recently. Anything older than the ceiling is written off — if it ever lands its cards are still
   *  applied, but it stops holding a slot. A stuck judge can cost one slot for two minutes; it can no
   *  longer cost the meeting. */
  const JUDGE_CEILING_MS = 120_000;
  const nowMs = Date.now();
  const active = [...s.inflight.values()].filter((t) => nowMs - t < JUDGE_CEILING_MS).length;
  if (active >= MAX_QUEUED_JUDGES) {
    s.dropped++;
    console.warn(`[ingest] judge backlog full (${active} active) — skipping this utterance to stay live`);
    trace("skip", `backlog full (${active} judges in flight) — utterance not judged`);
    await publish(req, s, body.title);
    return Response.json({ ok: true, speaker, heard: heard.length, added: 0, skipped: "backlog", cards: s.board.cards().length });
  }

  s.queued++;
  const tJudge = Date.now();
  /** ⚠️ THE JUDGE NO LONGER QUEUES BEHIND OTHER JUDGES. THIS IS WHAT MAKES A FREEZE IMPOSSIBLE.
   *
   *  It used to run on `s.chain`, so every utterance waited for every earlier one. That is
   *  head-of-line blocking, and it converts ONE slow leg into a frozen board: a single chunk that
   *  takes two minutes holds every chunk behind it, the backlog gate then starts skipping arrivals,
   *  and the canvas stops moving entirely. Every "it stales" and "swear words freeze the canvas"
   *  report has this shape — the trigger varied (a slow provider, a refusal, a retry ladder), the
   *  amplifier was always the queue.
   *
   *  Shortening the slow leg treats the trigger. Removing the queue removes the amplifier, and only
   *  one of those can be made to hold for triggers nobody has seen yet.
   *
   *  ⚠️ AND IT IS SAFE, because deriveActions is STATELESS PER CHUNK — it is handed topic names as
   *  strings rather than a board, which is the whole reason that refactor was done. The only ordered
   *  part is `s.board.apply()`, which is synchronous: Node cannot interleave it, so no lock is
   *  needed and none is taken. Cards may now land slightly out of order; a board that is one card
   *  out of sequence is not a defect worth a freeze.
   *
   *  Concurrency is still bounded by MAX_QUEUED_JUDGES — that gate now limits COST and fan-out, not
   *  latency, because a queued judge no longer delays anyone else. */
  const run = (async () => {
    let actions: RawAction[] = [];
    try {
      // ENTITIES FIRST, then whatever topics already exist. The judge reuses a name from this list
      // before inventing one, so the board's backbone becomes the things actually being discussed
      // rather than a cluster name improvised from a single ten-second breath.
      /** ⚠️ ENTITIES ARE FOR SPELLING, NOT FOR STRUCTURE. They used to be prepended here and handed
       *  to the judge under the heading "KNOWN TOPICS — reuse these names when they fit".
       *
       *  The entity index holds every proper noun and craft term heard in the call — Hetzner, deploy,
       *  workflow, mind map, Minami. Presenting those as TOPICS told the judge they were subjects it
       *  should reuse, and when speech was unclear reusing a plausible name is the path of least
       *  resistance. Observed live on 2026-08-21: a 29-card board whose topics were OCR, Link,
       *  Hetzner, Context, workflow, deploy, mind map, Second Brain and Ownego — a vocabulary list
       *  wearing the shape of an agenda. Anh named it on the call himself: "AI dùng topic cũ, không
       *  biết topic hiện tại".
       *
       *  Topics now come only from the board — things that really were established as subjects. The
       *  entity names still reach the judge, under KNOWN NAMES, which is where a spelling belongs. */
      const backbone = s.board.topicNames();
      const names = [
        ...glossaryFrom(s.lines.slice(-RECENT)),
        ...s.entities.entities().slice(0, 8).map((e) => e.name),
      ];
      actions = await deriveActions(
        [...new Set(backbone)],
        said.join("\n"),
        [...new Set(names)],
        // Labels already on the board, so the judge can hang this utterance UNDER an earlier point
        // instead of starting a fourth parallel thread about the same thing. Capped inside
        // deriveActions at the last 25 — a whole meeting of labels costs more and decides less.
        /** ⚠️ AN EDITED CARD IS MARKED, not silently identical to a generated one.
         *
         *  The judge is told to revise and merge freely, which is right for its own output and wrong
         *  for a person's. Without a marker anh's correction is just another label to improve, and it
         *  reverts within a chunk or two — visibly, on a shared screen. The pin is the whole reason
         *  editing is worth having. */
        s.board.cards().map((c) => ((c as { edited?: boolean }).edited ? `${c.label}  [EDITED BY A PERSON — do not change]` : c.label)),
        {
          cfg: mode.derive, spend, revise: true, context: s.context,
          /** The lines immediately BEFORE this chunk. `said` was already appended to s.lines above,
           *  so the run-up is the slice ending where this chunk begins. Four lines is enough to
           *  rejoin a sentence split by a hesitation without re-feeding the whole meeting. */
          before: s.lines.slice(Math.max(0, s.lines.length - said.length - 4), s.lines.length - said.length).join("\n"),
        },
      );
    } catch (e) {
      trace("error", `judge failed — ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`, Date.now() - tJudge);
      console.error("[ingest] derive failed:", e instanceof Error ? e.message : e);

      /** ⚠️ DEGRADE, DO NOT DROP. A failed judge used to lose the minute entirely — the words were
       *  heard, transcribed and paid for, and then thrown away because the model that shapes them
       *  into a card was unavailable.
       *
       *  During an important meeting a plain, true line on the board beats a gap. So the utterance
       *  goes up verbatim as a note, marked so nobody mistakes it for Minami's own summary, and
       *  marked EDITED so the tidy pass does not later rewrite a raw quote into something it thinks
       *  is tidier.
       *
       *  Only on a THROW. A judge returning zero actions is usually correct — silence, a fragment,
       *  small talk — and turning every one of those into a card would bury the board in noise. */
      const raw = said.join(" ").replace(/^[^:]*:\s*/, "").trim();
      if (raw.length >= 25) {
        const node = s.board.apply(
          { op: "card", kind: "note", label: raw.slice(0, 90), detail: raw.length > 90 ? raw.slice(0, 200) : undefined, source: raw, topic: s.topic },
          recentLines(s),
        );
        if (node) {
          s.board.editById?.(node.id, {});   // pins it: a raw quote must not be "improved" later
          s.lastCardAt = Date.now();         // a rescue is still a card — don't also trip the dead-man's switch
          trace("judge", `judge unavailable — kept the words verbatim instead`, Date.now() - tJudge);
          return { added: 1 };
        }
      }
      return { added: 0 };
    }
    let added = 0;
    // The RECENT window, not the whole meeting — see the note on RECENT. This is both the fix for the
    // quadratic cost and the thing that makes "grounded" mean what it says.
    const recent = s.lines.slice(-RECENT);
    /** ⚠️ WIPE THE WARM-UP BEFORE THE FIRST REAL CARD IS DRAWN, not after. Applying first would put a
     *  real card on a board still showing ghosts, and for one frame the room cannot tell which is
     *  which — on a screen being shared, that single frame is the whole risk of the feature. */
    if (actions.length) {
      const wiped = s.board.clearPlaceholders();
      if (wiped) console.log(`[ingest] warm-up cleared (${wiped}) — real cards arriving`);
    }
    for (const a of actions) if (s.board.apply(a, recent)) added++;
    // The single most useful line in the panel: "12 proposed → 0 on the board" is the signature of a
    // grounding or dedup rule quietly eating everything, which has happened more than once.
    trace("judge", `${actions.length} proposed → ${added} card(s) on the board`, Date.now() - tJudge);

    /** ⚠️ THE DEAD-MAN'S SWITCH — the last line of defence, and the only one that covers the failure
     *  mode that has actually cost meetings.
     *
     *  Every other guard here fires on an ERROR. The failures that hurt did not error. On 2026-08-21
     *  the judge returned a successful, well-formed, empty actions array for eight consecutive
     *  substantive utterances: clean logs, HTTP 200 throughout, every component reporting healthy, and
     *  a board that did not move while anh presented. The cause was five separate "return nothing"
     *  rules that were individually reasonable and collectively made silence the default — but the
     *  cause is not the point. The point is that NOTHING NOTICED. A pipeline can only be trusted to
     *  the extent it can tell the difference between "nothing worth saying" and "I have stopped
     *  working", and from the inside those are the same 200.
     *
     *  So stop asking why, and watch the outcome instead: if real speech keeps arriving and the board
     *  has not gained a card in DEAD_MAN_MS, quit trusting the judge and put the words up verbatim.
     *
     *  Three things keep this from becoming noise:
     *    · it needs SUBSTANCE — a longer line than the throw-path rescue, because this one is acting
     *      on suspicion rather than a real error;
     *    · a rescue card IS a card, so lastCardAt moves and the next one cannot fire for another full
     *      window — at most one verbatim line per DEAD_MAN_MS, never a stream;
     *    · it is pinned, so the tidy pass will not later rewrite a raw quote into a summary.
     *
     *  A plain true sentence on the board is worse than a good card and enormously better than a gap,
     *  and anh cannot debug this from inside a client call. That trade is the whole design. */
    if (added) s.lastCardAt = Date.now();
    else if (Date.now() - s.lastCardAt >= DEAD_MAN_MS) {
      const raw = said.join(" ").replace(/^[^:]*:\s*/, "").trim();
      if (raw.length >= 45) {
        const node = s.board.apply(
          { op: "card", kind: "note", label: raw.slice(0, 90), detail: raw.length > 90 ? raw.slice(0, 200) : undefined, source: raw, topic: s.topic },
          recent,
        );
        if (node) {
          s.board.editById?.(node.id, {});
          s.lastCardAt = Date.now();
          added = 1;
          console.warn(`[ingest] dead-man's switch — no card in ${DEAD_MAN_MS / 1000}s of speech, kept the words verbatim`);
          trace("judge", `board went quiet for ${DEAD_MAN_MS / 1000}s — kept the words verbatim`, Date.now() - tJudge);
        }
      }
    }
    return { added };
  })();
  // Tracked so `end` can drain judges that are no longer on the chain. Registered before the
  // finally() below so a fast judge cannot leave the set before it is added.
  s.inflight.set(run, Date.now());
  /** ⚠️ THE JUDGE IS NO LONGER ON THE RESPONSE PATH, AND THAT IS THE FIX FOR "IT STALES".
   *
   *  Measured 2026-08-18 on the real pipeline: STT 2.5-6s, judge 4.7-8.9s — awaited one after the
   *  other inside a single request, so a chunk cost 8-15s against a 10s chunk window. The pipeline
   *  simply could not keep up with speech, so the board sat a chunk or more behind and never
   *  recovered. Nothing errored; every request returned 200. It read as "stale" because that is
   *  exactly what it was.
   *
   *  Returning as soon as the audio is transcribed and the judge is QUEUED means the request costs
   *  the STT leg alone (~3-6s), comfortably inside the window. Cards still appear when the judge
   *  lands, which is the same wall-clock moment as before — but the requests stop stacking, and
   *  MAX_QUEUED_JUDGES finally sees a real queue depth instead of always finding 1 because the
   *  previous request had already blocked to completion.
   *
   *  The end path still awaits s.chain before archiving, so nothing in flight is lost. */
  void run
    .finally(() => { s.queued--; s.inflight.delete(run); })
    .then(() => publish(req, s, body.title))
    .catch(() => { /* the judge logs its own failures; a dropped publish costs one frame */ });

  const sttMs = Date.now() - tHeard;
  // Per-leg timing, always. The hardest thing about this pipeline has been that "slow" and "broken"
  // produce identical logs — a clean 200 either way.
  console.log(`[timing] stt=${sttMs}ms queued=${s.queued} chunk=${body.totalMs ?? "?"}ms`);
  /** ⚠️ DO NOT TRUNCATE THE TRANSCRIPT HERE. At 120 chars this cut every utterance mid-sentence, and
   *  the terms that get mangled are disproportionately at the END of a long sentence — so the panel
   *  hid exactly the evidence it exists to show. (Measured: a clip scored 5/10 on terminology when
   *  read from this line and 10/10 when read from the model's actual reply.) trace() caps at 300. */
  const gainNote = body.gain && body.gain > 1.01 ? ` [gain x${body.gain}]` : "";
  trace("hear", `[${mode.transcribe.model.replace(/^omni:/, "")}]${gainNote} ${speaker ?? "?"}: ${heard.join(" ")}`, sttMs);
  if (sttMs > (body.totalMs ?? 10_000)) {
    console.warn(`[timing] ⚠ the ear is slower than real time (${sttMs}ms for ${body.totalMs ?? "?"}ms of audio) — the board will fall behind`);
  }

  // (spend is now booked immediately after transcribe — see the note there)
  await publish(req, s, body.title);

  // ── CONSOLIDATE, IN THE BACKGROUND ────────────────────────────────────────────────────────────
  // Deliberately NOT awaited. The response is already sent and the board already published; a tidy
  // that took four seconds would otherwise add four seconds to every third utterance for no visible
  // benefit. Failure is swallowed for the same reason it is elsewhere: a missed tidy costs a slightly
  // messier board, a thrown one would cost the meeting.
  // `forceTidy` is what makes "Minami, dọn lại" mean anything; the cadence covers the rest. A spoken
  // tidy also ignores the 5-card floor, because anh asking is better evidence that the board needs it
  // than a card count is.
  if (forceTidy) s.forceTidy = false;
  if ((forceTidy || s.utterances % TIDY_EVERY === 0) && (forceTidy || s.board.cards().length >= 5)) {
    // ⚠️ ON THE CHAIN, not beside it. Tidy merges and revises the SAME board the judge writes to, and
    // mergeCards() splices from `nodes` and rewrites `edges` in place. Running it concurrently with a
    // judge call meant a card could be spliced away mid-apply, or an edge rewritten to point at a node
    // that no longer existed. Nothing about that would have failed loudly — it would have shown up as
    // cards or edges occasionally going missing, which is indistinguishable from the model's own
    // inconsistency and therefore essentially undebuggable.
    //
    // Serialising costs latency only on every third utterance, and only for the ~2-3s tidy takes.
    s.chain = s.chain.then(async () => {
      if (s.ended) return;
      const tTidy = Date.now();
      try {
        const tidySpend = noSpend();
        const { revise, merge, nest } = await refineBoard(
          s.board.cards().map((c) => ({ id: c.id, label: c.label, detail: c.detail })),
          s.lines.slice(-RECENT).join("\n"),
          { cfg: { ...mode.derive, model: mode.derive.tidyModel }, spend: tidySpend },
        );
        // Same cadence as the board tidy: drop one-off entity clusters so resolution does not get
        // slower as the meeting gets longer.
        s.entities.prune();
        let n = 0;
        for (const r of revise) if (s.board.reviseById(r)) n++;
        for (const m of merge) if (s.board.mergeById(m.from, m.into)) n++;
        s.cost += tidySpend.cost;
        if (!merge.length && !revise.length) {
          console.log(`[tidy] no changes proposed across ${s.board.cards().length} cards`);
          trace("tidy", `nothing to change across ${s.board.cards().length} cards`, Date.now() - tTidy);
        } else if (n && !s.ended) {
          console.log(`[tidy] ${merge.length} merged, ${revise.length} revised across ${s.board.cards().length} cards`);
          trace("tidy", `${merge.length} merged, ${revise.length} revised across ${s.board.cards().length} cards`, Date.now() - tTidy);
          await publish(req, s, body.title);
        } else {
          // Proposed but nothing applied — every id the model returned failed to resolve. That is a
          // real defect (stale ids, wrong shape) and it must not look like a quiet success.
          console.warn(`[tidy] proposed ${merge.length} merges / ${revise.length} revisions, APPLIED NONE`);
          // Loud in the panel too: "proposed N, applied 0" is the signature of stale ids, and it is
          // otherwise indistinguishable from a board that simply had nothing to tidy.
          trace("error", `tidy proposed ${merge.length} merges / ${revise.length} revisions and APPLIED NONE — ids did not resolve`, Date.now() - tTidy);
        }
        // APPLIED, not discarded. `void nest` sat here for the life of the project, which is the
        // whole reason boards never grew past two levels: the tidy pass computed a hierarchy every
        // 30 seconds and the result was dropped on the floor. Nesting is what makes this a mind map
        // rather than a list with headings.
        let nested = 0;
        for (const x of nest) if (s.board.nestById(x.id, x.under)) nested++;
        if (nest.length) {
          console.log(`[tidy] nest: ${nested}/${nest.length} applied${nested < nest.length ? " (rest rejected: cycle, missing id, or already there)" : ""}`);
          trace("tidy", `nesting: ${nested}/${nest.length} applied${nested < nest.length ? " (rest rejected: cycle, missing id, or already nested)" : ""}`);
        }
        if (nested) n += nested;
      } catch (e) {
        trace("error", `tidy failed — ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`, Date.now() - tTidy);
        console.error("[tidy] failed:", e instanceof Error ? e.message : e);
      }
    }).catch(() => {});
  }

  // `added` is gone from the response on purpose: the judge no longer finishes before we reply, so
  // there is no honest number to report. `queued` is the useful one — it says how far behind we are.
  return Response.json({
    ok: true,
    speaker,
    heard: heard.length,
    queued: s.queued,
    sttMs,
    cards: s.board.cards().length,
    costSoFar: +s.cost.toFixed(4),
  });
}
