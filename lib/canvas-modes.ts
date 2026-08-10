// The A/B ladder for the meeting canvas — see §17 in the knowledge record.
//
// Three arms, and the ORDER matters more than the contents: each one changes exactly one thing from
// the arm before it, so a difference in the numbers can actually be attributed. Swapping the ASR and
// the judging model at the same time would produce a faster, cheaper, better run that tells you
// nothing about WHICH change bought it.
//
//   A  mimo      control — precisely what shipped: a chat LLM doing ASR, 60s chunks
//   B  stt       swaps the ASR leg for a real STT model (and the chunking that assumed 13s/audio-min)
//   C  stt-fast  B, plus a faster judging model — run only once B has proved the ASR leg
//
// Judging stays on mimo in A and B on purpose. It costs ~$0.015 per audio-hour, which is noise next
// to the ASR leg, so there is nothing to win there and a variable to lose.

export type ModeId = "mimo" | "stt" | "stt-fast";

export type TranscribeEngine =
  /** Audio into /chat/completions, asking a general model to write out what it hears. */
  | { kind: "chat"; model: string }
  /** Audio into /audio/transcriptions — a model that only does ASR. */
  | { kind: "stt"; model: string; language?: string; diarize: boolean };

export type CanvasMode = {
  id: ModeId;
  label: string;
  /** One line, shown in the operator panel so you know which arm you're watching. */
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
  };
};

/** The judging model both control arms share. Kept as the existing env var so an A run today is
 *  identical to an A run last week. */
const JUDGE = process.env.OPENROUTER_MODEL || "xiaomi/mimo-v2.5";

/** Default challenger ASR. grok-stt-1.0 is the only model in OpenRouter's STT catalogue that does
 *  25+ languages WITH mid-stream switching AND speaker diarization, and it sits in the cheapest price
 *  tier at $0.10/audio-hour. Nova-3 diarizes too but its code-switching mode excludes Vietnamese. */
const STT_MODEL = process.env.CANVAS_STT_MODEL || "x-ai/grok-stt-1.0";

/** Empty = let the model detect and switch. Set to an ISO-639-1 code for a known single-language
 *  meeting: pinning it beats auto-detect, which is decided per chunk and can flap mid-call. */
const STT_LANGUAGE = process.env.CANVAS_STT_LANGUAGE || undefined;

const FAST_JUDGE = process.env.CANVAS_FAST_DERIVE_MODEL || "google/gemini-3-flash-preview";

export const MODES: Record<ModeId, CanvasMode> = {
  mimo: {
    id: "mimo",
    label: "A · mimo",
    blurb: "Control. Chat LLM transcribes and judges. 60s chunks.",
    // 60s was sized around ~13s of wall clock per audio-minute, and is about the longest chunk this
    // path transcribes reliably in one pass.
    chunkSeconds: 60,
    overlapSeconds: 6,
    concurrency: 3,
    transcribe: { kind: "chat", model: JUDGE },
    derive: { model: JUDGE, strictSchema: false, latencyRouting: false },
  },

  stt: {
    id: "stt",
    label: "B · real ASR",
    blurb: `Dedicated ASR (${STT_MODEL}) + 15s chunks. Same judge as A.`,
    // The 60s window only existed to amortise a 13s-per-audio-minute transcriber. A real ASR model
    // returns in well under a second, at which point the window is pure dead time — and on a live
    // call the window length IS the liveness floor, because you cannot transcribe speech that hasn't
    // been said yet.
    chunkSeconds: 15,
    overlapSeconds: 2,
    // Cheaper, faster calls tolerate more of them in flight. Still bounded: the cap exists because
    // removing it once pushed time-to-first-transcript from 8s to 29s.
    concurrency: 6,
    transcribe: { kind: "stt", model: STT_MODEL, language: STT_LANGUAGE, diarize: true },
    derive: { model: JUDGE, strictSchema: true, latencyRouting: true },
  },

  "stt-fast": {
    id: "stt-fast",
    label: "C · ASR + fast judge",
    blurb: `B, but judged by ${FAST_JUDGE}. ~7x the judging cost — only worth it if B proves judging is the bottleneck.`,
    chunkSeconds: 15,
    overlapSeconds: 2,
    concurrency: 6,
    transcribe: { kind: "stt", model: STT_MODEL, language: STT_LANGUAGE, diarize: true },
    derive: { model: FAST_JUDGE, strictSchema: true, latencyRouting: true },
  },
};

export const DEFAULT_MODE: ModeId = "mimo";

export function resolveMode(raw: string | null | undefined): CanvasMode {
  return MODES[(raw ?? "") as ModeId] ?? MODES[DEFAULT_MODE];
}
