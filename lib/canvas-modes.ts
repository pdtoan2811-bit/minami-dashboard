// The meeting canvas pipeline config — see §17 in the knowledge record.
//
// This used to be a three-arm A/B ladder (mimo control → real ASR → fast judge). The ladder did its
// job: it proved a chat LLM should never have been doing ASR, and mimo lost on every axis that
// mattered. Measured on the same audio, the same afternoon:
//
//   mimo judging a 15s chunk   3s … 5s … 44s … 48s … 80s   (the spread is the disqualifier, not the
//                                                           mean — a live path cannot budget for a
//                                                           judge that is sometimes 25x its own
//                                                           typical time)
//   mimo relating a board      105s, then 220s
//   flash tidying a board      2.4s, twice, applying 5 and 6 sensible changes
//
// mimo also burned ~3,100 reasoning tokens before emitting its first character, which is what made
// every early token budget silently return an empty board. It is now removed entirely — model,
// arms, and the chat-as-ASR code path with it.
//
// What is left is one configuration: a real ASR model for hearing, and one fast model for all three
// thinking passes. Keep the MODES shape anyway — the operator panel and the `report` event are both
// keyed by mode id, and the next real experiment (chunk size, below) wants somewhere to live.
//
// ⚠️ Every cost figure in §17 was measured with mimo judging. Exactly one of them survives that
// model's removal: the ASR leg at $0.110/audio-hour. Treat the rest as unmeasured until a `live` run
// has printed its own `report`.

export type ModeId = "live" | "gemini";

export type TranscribeEngine = {
  /** Audio into /audio/transcriptions — a model that only does ASR. */
  kind: "stt";
  model: string;
  language?: string;
  /** ROOM MODE — several people sharing ONE microphone.
   *
   *  Recall streams per-participant audio, so speaker identity is normally free: one stream, one
   *  name, no guessing. That breaks the moment anh is in a room with people who are not in the call
   *  — everyone arrives on his mic, attributed to him, and the board records a discussion as a
   *  monologue.
   *
   *  `known` is the roster gathered so far, fed back so labels stay stable between chunks. */
  room?: { known: string[] };
};

export type CanvasMode = {
  id: ModeId;
  label: string;
  /** One line, shown in the operator panel so you know what you're watching. */
  blurb: string;
  chunkSeconds: number;
  overlapSeconds: number;
  concurrency: number;
  transcribe: TranscribeEngine;
  derive: {
    model: string;
    /** response_format: json_schema, which removes the reparse-and-retry path. */
    strictSchema: boolean;
    /** provider.sort + preferred_max_latency, so OpenRouter stops parking us on a slow endpoint. */
    latencyRouting: boolean;
    /** Model for the once-per-run whole-board relationship + reaction pass.
     *
     *  Its own knob because this is the one step that sees every card at once, so it is where more
     *  reasoning genuinely bought better edges — and also where it cost the most. Left on the fast
     *  model by default: 105s of edges arriving after the meeting ended is not a trade the default
     *  should make on your behalf. Point it at a stronger model when you care more about edge
     *  quality than about when they show up. */
    relateModel: string;
    /** Model for the mid-meeting tidy pass. Always the FAST model, for the opposite reason to
     *  relateModel: this one runs WHILE the meeting is going, and no result is worth 60s inside a
     *  15s chunk. Tidying is also bounded and well-specified — read a dozen cards, spot the
     *  duplicate — which is what a small fast model is good at. */
    tidyModel: string;
  };
};

/** The ASR model.
 *
 *  ⚠️ CHANGED 2026-08-12 after the first side-by-side test on real audio. The previous default,
 *  x-ai/grok-stt-1.0, was chosen from a spec sheet — 25+ languages, mid-stream switching, cheapest
 *  tier — and never once tested against speech. Run against a clip where the ground truth was "Luna,
 *  Terra, and the big boy being Sol", it produced "Tara" and "sold"; whisper, qwen, voxtral and both
 *  gpt-4o variants all got it right. It was among the WORST on the list, at a price four of them beat.
 *
 *  whisper-large-v3: $0.090/audio-hour (the cheapest of the accurate ones), 99 languages, and the
 *  long-standing benchmark for robustness to accented speech — which is the entire workload here.
 *
 *  Fast enough, measured rather than assumed: median 1.26s / 1.49s / 2.32s on 4s / 8s / 12s clips,
 *  worst case 2.45s over twelve runs, spread 1.6-2.0x. That is ~0.7s slower than grok on a 12s chunk
 *  and about 4% of the end-to-end time to a card — the 10s chunk ceiling dominates by 4x. Spread is
 *  what actually disqualifies a model on a live path (see mimo, 3s to 80s on identical work), and
 *  whisper's is tight.
 *
 *  ⚠️ AND THEN THE REAL TEST OVERTURNED IT. Run against 9.1s of anh's own speech from a live meeting
 *  — ground truth "mind maps on the canvas … mind maps for me" — whisper produced "MY maps", twice.
 *  So did grok, chirp-3 and nova-3. gpt-4o-transcribe silently dropped two thirds of the clip.
 *
 *  Correct on the real voice: qwen3-asr-flash, gpt-4o-mini-transcribe, voxtral-mini.
 *
 *  qwen3-asr-flash wins outright — right, FASTEST of all eight at 1.3s, tightest latency spread, and
 *  $0.124/audio-hour. Trained heavily on Asian-accented speech, which is the entire workload here.
 *  (gpt-4o-mini-transcribe is the value pick at $0.084/hr and equally correct; the $0.04/hr gap does
 *  not buy back qwen's speed and consistency.)
 *
 *  ⚠️ AND THEN QWEN LOST TOO, ON A FULL MEETING. Set as default and run for 6.6 minutes, it produced
 *  "my mask" and "my maps" for MIND MAP, and "Minamino"/"Midami" for MINAMI — and "Minamino" then
 *  became the TOPIC NAME for the whole board. One misheard proper noun propagated into the board's
 *  structure. Back on whisper at anh's request; the difference between these models is smaller than
 *  the difference a vocabulary makes.
 *
 *  ⚠️ AND THEN WHISPER FAILED OUTRIGHT ON VIETNAMESE. Measured live mid-meeting 2026-08-13: with no
 *  `language` pinned, whisper-large-v3 returns the literal string "foreign" and transcribes NOTHING.
 *  Nine utterances produced zero cards. Pinning language=vi makes it work but garbled; qwen and
 *  gpt-4o-mini-transcribe both handled the same clip cleanly with no pin at all.
 *
 *  qwen3-asr-flash is therefore the default for good: it is the only model tested that is correct on
 *  anh's accented English AND auto-detects Vietnamese without being told. For a VI/EN meeting that
 *  code-switches mid-sentence, auto-detection is not a convenience — it is the requirement, because
 *  there is no single language to pin.
 *
 *  ⚠️ THE MODEL IS NOT THE MAIN LEVER for accuracy. Every model tested still mangles the same handful
 *  of proper nouns, because no general ASR knows what "Minami" or "qone" is. server/canvas-vocab.mjs
 *  is that fix: terms biased into the decode and corrected on the way out. */
/** DEFAULT EAR: qwen3-asr-flash — restored, and the reason it was ever moved is the lesson.
 *
 *  Blaze was made default on 2026-08-17 after ONE clip of macOS `say -v Linh` — synthetic Vietnamese,
 *  no accent, no room, no code-switching under load. It won that test. On the first real meeting it
 *  fell apart on anh's actual voice: it looped "Có thể là do tôi không nói rõ." THREE times, and
 *  emitted "Lốc lốc, lốc lốc", "Nhưng mà không quỳ", "Thả về tim em" — hallucination loops, the same
 *  failure whisper had with its YouTube outros.
 *
 *  ⚠️ SYNTHETIC SPEECH CANNOT RANK ASR MODELS. A TTS voice is the clean case every model is best at;
 *  the thing that separates them is a real larynx in a real room. The eight-model comparison below was
 *  run on anh's own recordings and it already had the answer — this default should only ever move on
 *  evidence of that kind. */
/** ⚠️ THIS LINE IS THE ONLY DECLARATION OF THE EAR. It has drifted three times now — a pin in
 *  .env.local silently overrode it twice, and .env.example and minami-setup each named a different
 *  model again. If you change it, change it HERE and nowhere else.
 *
 *  omni: gemini-3-flash — measured 2026-08-18 on a clip carrying ten English technical terms inside
 *  Vietnamese speech, with the vault glossary supplied: 10/10 terms correct, against whisper's 4/10
 *  ("second drive", "ai dớn", "Eqoil", "headroom.net"). The gap is CONTROLLABILITY, not model
 *  quality — three separate ASR biasing parameters have been probed inert on this stack
 *  (OpenRouter's provider.options.keyterm, Blaze's `prompt`, whisper's own `prompt`), so a pure ASR
 *  cannot be told that "workflow" is a word. An omni model can, because the instruction is the
 *  message. It costs chat-model rates and roughly doubles latency; that is the trade. */
const STT_DEFAULT = "omni:google/gemini-3-flash-preview";
const STT_MODEL = process.env.CANVAS_STT_MODEL || STT_DEFAULT;

/** ⚠️ AN EAR OVERRIDE MUST NEVER BE SILENT. This is the fourth time the line above has been
 *  overridden from outside and the first three were all found by accident.
 *
 *  The fourth was the worst, because it did not come from a file anyone could read: a stale
 *  `CANVAS_STT_MODEL=qwen/qwen3-asr-flash` sat in a PARENT PROCESS's environment and was inherited by
 *  everything launched from that shell. `.env.local` was clean, `git diff` was clean, the code default
 *  said gemini — and the running server was on qwen, which is a pure ASR and therefore cannot be told
 *  that "workflow" is a word. Measured on one Vietnamese clip carrying ten English technical terms:
 *  0/10 on the inherited qwen, 10/10 on the code default. Identical audio, identical prompt.
 *
 *  Nothing in the app can stop an operator exporting a variable. What it can do is refuse to be quiet
 *  about it, so the next person spends one second on this instead of an afternoon. */
if (process.env.CANVAS_STT_MODEL && process.env.CANVAS_STT_MODEL !== STT_DEFAULT) {
  console.warn(
    `[canvas] ⚠ EAR OVERRIDDEN BY THE ENVIRONMENT: CANVAS_STT_MODEL="${process.env.CANVAS_STT_MODEL}" ` +
    `is in use instead of the code default "${STT_DEFAULT}". If you did not set this deliberately, it ` +
    `was inherited from a parent shell — unset it and restart. A non-"omni:" ear cannot keep English ` +
    `terminology inside Vietnamese speech.`,
  );
}

/** ⚠️ PIN THIS. Auto-detect is not neutral — it changes what the model DOES.
 *
 *  Measured on real clips 2026-08-14, same audio, chirp-3, the only difference being this field:
 *
 *    auto : "entity of the word that I said is EC, as in the letter E and the letter C."
 *    vi   : "entity của cái bốn câu chuyện này đó là EC như như letter E and the letter C."
 *
 *  Auto-detect TRANSLATES the Vietnamese into English prose. Pinned, it transcribes what was actually
 *  said and lets the English terms through verbatim — so code-switching survives, which is the whole
 *  requirement. It also picks a language per chunk, and on one live board that produced a French card
 *  ("Auto-vendang pour la base de connaissances") and a German word, from Vietnamese audio.
 *
 *  Pin to the DOMINANT language of the meeting, not to "the language being spoken this second". */
const STT_LANGUAGE = process.env.CANVAS_STT_LANGUAGE || undefined;

/** One model for all three thinking passes: judge (per chunk), tidy (mid-meeting), relate (once).
 *
 *  Priced on OpenRouter 2026-08-12 — $0.072/M in, $0.144/M out, $0.0144/M cache read, 1,048,576
 *  context. Against google/gemini-3-flash-preview ($0.50 / $3.00, plus $3.00/M for internal_reasoning
 *  you are billed for and never see) that is ~7x cheaper on input and ~21x on output, which drops the
 *  predicted judging leg from ~$1.17/audio-hour to ~$0.07 and makes the Recall bot ~85% of the bill.
 *
 *  ⚠️ Chosen on PRICE, and price is the one axis that never mattered here. mimo was cheap too and
 *  lost on latency variance — 3s to 80s judging the same size chunk — which is exactly what a live
 *  board cannot absorb. Nothing has measured this model's latency, its JSON compliance under
 *  strictSchema, or its Vietnamese. The `report` event exists to settle that; run it before trusting
 *  the number above.
 *
 *  ⚠️ `~…-latest` is a floating alias: the model behind it can change without the id changing. Good
 *  for staying current, bad for a scorecard that compares runs across weeks — a cost or latency shift
 *  may be the model moving rather than anything you did. Pin deepseek/deepseek-v4-flash-0731 when a
 *  run needs to be reproducible. */
export const DEFAULT_JUDGE = "~deepseek/deepseek-v4-flash-latest";
const JUDGE = process.env.CANVAS_DERIVE_MODEL || DEFAULT_JUDGE;

const RELATE_MODEL = process.env.CANVAS_RELATE_MODEL || JUDGE;

/** `~vendor/model-name` → `model-name`. OpenRouter's ids carry a vendor prefix and, for floating
 *  aliases, a leading tilde; neither helps you read a label at a glance. */
const short = (id: string) => id.replace(/^~/, "").split("/").pop() ?? id;

/** The models this run bills, as one string. Derived from the same values the pipeline uses so the
 *  label can never quietly disagree with what gets charged — the operator panel shows the combo
 *  rather than a name someone has to remember the meaning of. */
function comboLabel(hear: string, think: string, relate: string): string {
  const base = `${short(hear)} × ${short(think)}`;
  return relate === think ? base : `${base} (+${short(relate)} relating)`;
}

/** THE knob worth sweeping, and still never swept.
 *
 *  Chunk length is the liveness floor — you cannot transcribe speech that hasn't been said yet — so
 *  15s is the shortest useful window and buys a measured 1.3s to first transcript. It is also a cost
 *  multiplier on every leg that runs per chunk: judging at 15s makes 240 calls an hour, at 60s it
 *  makes 60. Predicted spread on the judging leg alone is ~$1.17/hr against ~$0.33/hr.
 *
 *  Env-overridable precisely so that sweep needs a restart rather than a patch. Overlap scales with
 *  it: a cut lands mid-sentence roughly every time, and overlapping means every sentence appears
 *  whole in at least one chunk. */
const CHUNK_SECONDS = Number(process.env.CANVAS_CHUNK_SECONDS || 15);
const OVERLAP_SECONDS = Number(process.env.CANVAS_OVERLAP_SECONDS || Math.max(2, Math.round(CHUNK_SECONDS * 0.13)));

/** The challenger. Kept as a named arm rather than an env override so an A/B is one URL parameter,
 *  and so the comparison is still available after someone edits their `.env.local`. */
const GEMINI = process.env.CANVAS_ALT_DERIVE_MODEL || "google/gemini-3-flash-preview";

/** Build an arm that differs from every other arm in EXACTLY ONE THING: the thinking model.
 *
 *  This is the whole discipline the old three-arm ladder was built on and the reason it could
 *  attribute anything. Chunking, overlap, concurrency, strict schema, latency routing and the ASR
 *  model are all shared here by construction — not by two object literals that happen to agree
 *  today. A difference in the report is therefore a difference in the model, full stop. */
function arm(id: ModeId, think: string, relate = think): CanvasMode {
  return {
    id,
    label: comboLabel(STT_MODEL, think, relate),
    blurb: `${short(STT_MODEL)} hears; ${short(think)} judges, relates and tidies.`,
    chunkSeconds: CHUNK_SECONDS,
    overlapSeconds: OVERLAP_SECONDS,
    // Bounded, and the bound is not decoration: removing it once pushed time-to-first-transcript
    // from 8s to 29s and failed two chunks in three.
    concurrency: Number(process.env.CANVAS_CONCURRENCY || 6),
    transcribe: { kind: "stt", model: STT_MODEL, language: STT_LANGUAGE },
    derive: { model: think, strictSchema: true, latencyRouting: true, relateModel: relate, tidyModel: think },
  };
}

export const MODES: Record<ModeId, CanvasMode> = {
  live: arm("live", JUDGE, RELATE_MODEL),
  gemini: arm("gemini", GEMINI),
};

export const DEFAULT_MODE: ModeId = "live";

/** What the run actually bills, for display. Derived from the same object the pipeline uses, so a
 *  label can't quietly disagree with the model that gets charged. */
export function modelsOf(m: CanvasMode) {
  return {
    hear: m.transcribe.model,
    judge: m.derive.model,
    relate: m.derive.relateModel,
    tidy: m.derive.tidyModel,
  };
}

export function resolveMode(raw: string | null | undefined): CanvasMode {
  return MODES[(raw ?? "") as ModeId] ?? MODES[DEFAULT_MODE];
}
