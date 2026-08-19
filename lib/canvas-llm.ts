// OpenRouter client for the meeting canvas.
//
// Two jobs, deliberately two calls: audio → transcript, then transcript → canvas actions. Doing it
// in one call is cheaper and hears tone, but you never see WHAT it heard — so a wrong card becomes
// unexplainable. The transcript is the artifact that makes every downstream mistake debuggable.
//
// Hearing goes to /audio/transcriptions — a model that only does ASR. It used to have a rival: audio
// into /chat/completions, asking a general model to write out what it heard. That path shipped first
// only because the dedicated endpoint did not exist yet, and it lost decisively — ~13s per audio
// minute, one chunk in three returning blank, and the same invented product name coming back three
// different ways across identical audio. It is gone; see lib/canvas-modes.ts for the numbers.
//
// The STT endpoint is batch-only: 60s upstream compute ceiling, base64 or ≤25MB multipart, no URLs,
// no streaming. That is the ceiling on how live "live" can be, and it is a property of OpenRouter
// rather than of any model — liveness bottoms out at chunk length + ~1s.
//
// Every call reports what it cost and how long it took. OpenRouter always returns `usage.cost` now —
// the old `usage: {include: true}` flag is deprecated and has no effect.

import { DEFAULT_JUDGE } from "./canvas-modes";
import type { CanvasMode, TranscribeEngine } from "./canvas-modes";

const BASE = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

/** BLAZE — a Vietnamese-native speech stack (api.blaze.vn), used as the default ear.
 *
 *  Measured 2026-08-17 on one clip of Vietnamese carrying English tech terms, the exact code-switching
 *  case that has failed all year. Ground truth: "…cái real-time streaming của Minami, vì con model
 *  Whisper nó nghe tiếng Việt không chuẩn. Deploy lên Hetzner rồi test lại nhé."
 *
 *    blaze            every Vietnamese word and diacritic correct; "real-time streaming" correct
 *    google/chirp-3   Vietnamese correct, but invented "Real-time Speech Premium"
 *    whisper-large-v3 BROKE THE VIETNAMESE — "không trần" for "không chuẩn"
 *
 *  All three mangled the English proper nouns, which is what canvas-vocab.mjs `correctText()` is for.
 *  The clip was macOS `say -v Linh`, so those nouns were pronounced with Vietnamese phonetics — a
 *  harsher test than a person saying them. Treat the Vietnamese result as the finding, not the nouns.
 *
 *  ⚠️ TWO PARAMETERS THAT LOOK USEFUL AND ARE NOT — both probed on the same clip:
 *    prompt              INERT. Supplying the full glossary shifted one hallucination
 *                        ("Voice Spell"→"Office Spell") and adopted NONE of the supplied terms. It is
 *                        the keyterm trap again: accepted, billed, ignored. So it is not sent.
 *    enable_refinement   RETURNS HTTP 200 WITH AN EMPTY STRING. Enabling it by default would have
 *                        blanked every utterance and left the board empty for a whole call, with a
 *                        clean log. Never send it without re-probing.
 *    enable_segments     HTTP 500. Not "ignored" — a hard failure on every chunk. It was in the first
 *                        cut of this function and would have broken the ear completely; caught only by
 *                        running the real request instead of trusting the schema.
 *    response_format     `verbose_json` is accepted and returns no segments anyway, so it buys nothing.
 *
 *  ⚠️ Blaze bills SEPARATELY from OpenRouter and its response carries no usage block, so these calls
 *  contribute ZERO to canvas-budget's monthly ceiling. The $50 gate now bounds the judge, not the ear. */
const BLAZE_BASE = process.env.BLAZE_BASE_URL || "https://api.blaze.vn/v1";
const BLAZE_KEY = process.env.BLAZE_API_KEY || "";

/** ── THE OMNI EAR: an audio-capable LLM told what to do, instead of an ASR that can only be hinted.
 *
 *  Measured 2026-08-18 on one clip carrying ten English technical terms inside Vietnamese speech:
 *
 *    whisper-large-v3   4/10 terms   "second drive", "ai dớn", "Eqoil", "headroom.net"
 *    gemini-3-flash     8/10 terms   second brain, agent, context, update memory, deploy, Hetzner all correct
 *
 *  The gap is not model quality, it is CONTROLLABILITY. Three separate biasing parameters have now
 *  been proved inert on this stack — OpenRouter's provider.options.keyterm, Blaze's `prompt`, and
 *  whisper's own `prompt` (byte-identical output with and without it, and with language=vi). A pure
 *  ASR cannot be told that "workflow" is a word and "hấp phương" is not. An omni model can, because
 *  the instruction is the message rather than a hopeful parameter.
 *
 *  ⚠️ IT IS A CHAT COMPLETION, NOT A TRANSCRIPTION. Different endpoint, different body shape, and it
 *  can refuse or editorialise — hence the explicit "return only the transcription" instruction and the
 *  empty-result guard below. It also costs chat-model rates rather than ASR rates.
 *
 *  ⚠️ SYNTHETIC CLIP CAVEAT, AGAIN. This was macOS `say`, not anh's larynx — the same evidence that
 *  wrongly promoted Blaze. Treat it as "worth switching to mid-call and judging live", not as proven. */
async function transcribeOmni(
  engine: Extract<TranscribeEngine, { kind: "stt" }>,
  audio: Buffer,
  format: string,
  terms: string[],
  spend?: Spend,
): Promise<TranscriptResult> {
  const model = engine.model.replace(/^omni:/, "");
  const t0 = Date.now();
  const glossary = terms.filter(Boolean).map((t) => t.trim()).filter(Boolean).slice(0, 40).join(", ");
  /** ⚠️ ROOM MODE IS WHY THE OMNI EAR EARNS ITS COST TWICE.
   *
   *  A pure ASR returns a wall of text; separating voices needs diarization it does not do. An omni
   *  model can simply be TOLD there are several people on one microphone — the same controllability
   *  that let it keep English terminology when three separate biasing parameters had been proved
   *  inert.
   *
   *  The naming rule is the semantic part, and it is what makes this useful rather than a labelling
   *  exercise: "Người 1" tells anh nothing a week later. People say each other's names constantly —
   *  they greet, they hand over, they ask "anh Tùng nghĩ sao?" — so the instruction is to LISTEN for
   *  the name and use it the moment it is heard, falling back to a number only until then.
   *
   *  ⚠️ HONEST LIMIT: each chunk is transcribed independently, so the model cannot match a VOICE it
   *  heard 30 seconds ago. Stability across chunks therefore comes from names, not from acoustics —
   *  the roster is fed back in so a person keeps their name once discovered. True cross-chunk voice
   *  identity needs speaker embeddings, which is a different build (Blaze exposes one).
   */
  const roomRule = engine.room
    ? "NHIỀU NGƯỜI ĐANG NÓI CHUNG MỘT MICRO. Tách từng lượt nói và ghi theo đúng định dạng:\n" +
      "<tên hoặc Người N>: <câu nói>\n" +
      "Mỗi lượt một dòng. Khi nghe được TÊN THẬT của ai đó — họ tự giới thiệu, hoặc người khác gọi tên " +
      "họ — hãy dùng tên đó từ đó trở đi thay cho 'Người N'. " +
      (engine.room.known.length
        ? `Những người đã biết trong cuộc họp này: ${engine.room.known.join(", ")} — hãy dùng lại đúng các tên này khi giọng nói khớp. `
        : "") +
      "Nếu chỉ có một người nói, vẫn ghi một dòng với tên của họ. "
    : "";

  const system =
    "Bạn là máy phiên âm. Chép lại NGUYÊN VĂN đoạn ghi âm, không tóm tắt, không thêm bớt. " +
    "Người nói dùng tiếng Việt xen lẫn thuật ngữ kỹ thuật tiếng Anh — GIỮ NGUYÊN thuật ngữ tiếng Anh " +
    "bằng tiếng Anh, đúng chính tả, KHÔNG phiên âm sang tiếng Việt. " +
    /** ⚠️ DOMAIN CONTEXT AS INSTRUCTION, NEVER AS NARRATIVE.
     *
     *  Removing asrPrompt's sentence stopped the hallucination and cost real accuracy: 10/8 terms
     *  became 5/8, identically across three runs, so it was the framing doing the work and not luck.
     *  The model needs to know it is hearing a technical product meeting; it must not be handed a
     *  sentence it can simply continue.
     *
     *  So the context is stated as a labelled field with an explicit "this is not content" clause,
     *  rather than as prose. Same information, nothing to autocomplete. */
    (glossary
      ? `NGỮ CẢNH: đây là cuộc họp kỹ thuật về sản phẩm và phần mềm. ` +
        `THUẬT NGỮ CÓ THỂ XUẤT HIỆN (chỉ dùng để viết ĐÚNG CHÍNH TẢ khi nghe được — đây KHÔNG phải ` +
        `nội dung cuộc họp và KHÔNG được dùng để tạo câu): ${glossary}. `
      : "") +
    roomRule +
    "Nếu không nghe rõ, bỏ qua phần đó. Chỉ trả về câu đã chép, không giải thích, không thêm dấu ngoặc. " +
    // ⚠️ THE ANTI-INVENTION RULE. Without an explicit escape hatch the model treats "produce a
    // transcript" as mandatory and fills the silence from whatever context it has — which is how a
    // glossary became a fake meeting. Saying nothing must be a legal answer.
    "QUAN TRỌNG: nếu đoạn ghi âm KHÔNG có lời nói nào (im lặng, tiếng ồn, tiếng gõ phím), hãy trả về " +
    "ĐÚNG một chuỗi rỗng. TUYỆT ĐỐI không bịa nội dung, không đoán, không dùng danh sách thuật ngữ ở " +
    "trên để tạo ra câu. Danh sách đó chỉ để viết đúng chính tả khi nghe được, không phải nội dung cuộc họp.";

  if (process.env.CANVAS_DUMP_EAR_PROMPT === "1") {
    console.log(`[omni] model=${model} terms=${terms.length} glossaryChars=${glossary.length} audioBytes=${audio.length} format=${format}`);
    console.log(`[omni] SYSTEM >>>${system}<<<`);
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60_000);
  let data: any;
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST", headers: headers(), signal: ctl.signal,
      body: JSON.stringify({
        model,
        // Deterministic: this is transcription, and creativity here is called hallucination.
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: [{ type: "input_audio", input_audio: { data: audio.toString("base64"), format } }] },
        ],
      }),
    });
    data = JSON.parse(await res.text());
  } finally { clearTimeout(t); }
  if (data?.error) throw new Error(JSON.stringify(data.error).slice(0, 200));
  bill(spend, data, t0);
  let text = String(data?.choices?.[0]?.message?.content ?? "").trim();

  /** ⚠️ BELT AND BRACES AGAINST INVENTION. An instruction is a request, not a guarantee, and this
   *  particular failure puts fabricated cards on a screen anh is sharing with a customer — so it gets
   *  a check as well as a rule.
   *
   *  Two signals, both cheap: the reply opening with the glossary's own framing, and a reply whose
   *  words are almost entirely drawn from the term list. Real speech about these subjects still
   *  contains ordinary connecting words; a fabrication assembled from the list does not. */
  if (/^this is a (product )?meeting/i.test(text)) {
    console.warn("[omni] discarded a reply that began by echoing the glossary prompt");
    text = "";
  } else if (text && glossary) {
    const vocabWords = new Set(glossary.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
    const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
    if (words.length >= 6 && words.filter((w) => vocabWords.has(w)).length / words.length > 0.7) {
      console.warn("[omni] discarded a reply that was almost entirely glossary terms — likely invented");
      text = "";
    }
  }
  // A refusal or an empty completion must not read as silence — it is a failure, and the caller's
  // ladder should see it as one.
  if (!text) throw new Error("omni: empty completion");
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  return { lines, speakers: 0, profile: "omni" };
}

/** Blaze speaks multipart/form-data with a `file` part — NOT the JSON `input_audio` shape OpenRouter
 *  takes — so it needs its own request, not a base-URL swap. */
async function transcribeBlaze(
  engine: Extract<TranscribeEngine, { kind: "stt" }>,
  audio: Buffer,
  format: string,
  spend?: Spend,
): Promise<TranscriptResult> {
  if (!BLAZE_KEY) throw new Error("blaze: BLAZE_API_KEY is not set — run `node bin/minami-setup.mjs`");
  const t0 = Date.now();
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(audio)]), `chunk.${format}`);
  if (engine.language) fd.append("language", engine.language);
  // Nothing else is sent, and that is a measured decision — see the parameter notes above. Blaze
  // returns TEXT ONLY: `response_format=verbose_json` yields no segments, and `enable_segments=true`
  // 500s outright. No segments means no speaker labels from the ear, which costs nothing here because
  // speaker identity comes from Recall's per-participant streams, not from the transcript.

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60_000);
  let data: any;
  try {
    const res = await fetch(`${BLAZE_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${BLAZE_KEY}` },
      body: fd,
      signal: ctl.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`blaze ${res.status}: ${raw.slice(0, 160)}`);
    data = JSON.parse(raw);
  } finally {
    clearTimeout(t);
  }
  // No usage block to bill, but the latency is still worth recording so a slow ear is visible.
  if (spend) spend.ms += Date.now() - t0;
  const { lines, speakers } = linesFromSTT(data);
  if (!lines.length) throw new Error("blaze: empty transcript");
  return { lines, speakers, profile: "blaze" };
}
/** ⚠️ ONE SOURCE OF TRUTH. This file used to declare its own fallback — "google/gemini-3-flash-preview"
 *  — while lib/canvas-modes.ts declared "~deepseek/deepseek-v4-flash-latest". Both read the same env
 *  var, so they agreed whenever it was set and DISAGREED whenever it wasn't: any call that did not
 *  pass an explicit model ran a different model from every call that did.
 *
 *  That makes every statement about "which model produced this board" unverifiable, which is exactly
 *  the failure the repo's own rule about model pins exists to prevent. Imported now, so there is one
 *  id and it cannot drift. */
const MODEL = process.env.CANVAS_DERIVE_MODEL || DEFAULT_JUDGE;

function headers() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set — put it in .env.local");
  const h: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  // Optional attribution for OpenRouter's public rankings.
  if (process.env.OPENROUTER_SITE_URL) h["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
  if (process.env.OPENROUTER_APP_NAME) h["X-Title"] = process.env.OPENROUTER_APP_NAME;
  return h;
}

type Msg = { role: "system" | "user"; content: unknown };

/** What a run spent on one leg. Accumulated in place because every helper below can make more than
 *  one call — a retried blank reply still costs money, and a comparison that hides the retries would
 *  make the arm that fails a third of the time look like the cheap one. */
export type Spend = { cost: number; ms: number; calls: number; empties: number };

export const noSpend = (): Spend => ({ cost: 0, ms: 0, calls: 0, empties: 0 });

export function addSpend(into: Spend, from: Spend): Spend {
  into.cost += from.cost; into.ms += from.ms; into.calls += from.calls; into.empties += from.empties;
  return into;
}

/** Per-call knobs. All optional, so existing call sites are unchanged. */
type CallOpts = {
  /** Which model. Defaults to CANVAS_DERIVE_MODEL; the relate and tidy passes override it. */
  model?: string;
  /** Extra body fields: response_format, provider routing. */
  extra?: Record<string, unknown>;
  /** Accumulator to bill this call into. */
  spend?: Spend;
};

/** A completion, retried on a BUDGET failure with a bigger budget.
 *
 *  The blank replies that dominated this pipeline were not the model declining to answer — they were
 *  `max_tokens` exhaustion. Measured decisively on mimo:
 *
 *    max_tokens=3000 -> finish_reason=length, 3000 tokens burned, 0 chars of content
 *    max_tokens=6000 -> finish_reason=stop,   3111 tokens burned, valid answer
 *
 *  The model spends ~3,100 tokens reasoning before it emits anything, and every budget this pipeline
 *  used (600, 900, 1200, 1500, 2000) sat below that line — so the call was cut off mid-thought and
 *  returned a valid 200 with content: null. That one fact explains "nothing worth keeping" on chunks
 *  full of substance, a third of chunks producing no transcript, zero relationships however the
 *  prompt was worded, and why LOWERING the budget during "optimisation" made everything worse.
 *
 *  So retrying repeats nothing: it DOUBLES the budget, because re-sending a budget that already
 *  proved too small just buys the same failure again at the same price.
 *
 *  Also worth knowing: `reasoning: { exclude: true }` does NOT stop the model generating reasoning.
 *  It only strips it from the response — the tokens are still spent and still counted against
 *  max_tokens. It saves nothing and hides the evidence. */
async function chat(messages: Msg[], maxTokens: number, timeoutMs = 240_000, opts: CallOpts = {}): Promise<string> {
  let budget = maxTokens;
  let lastErr: Error | null = null;
  /** ⚠️ `timeoutMs` IS THE TOTAL, NOT THE PER-ATTEMPT ALLOWANCE.
   *
   *  It used to be handed to all three attempts in full, so a caller asking for 45s could be held for
   *  135s — and deriveActions does exactly that: it computes a 45s `deadline`, then only re-checks it
   *  BETWEEN its own two attempts, with no idea that the call inside had already tripled it.
   *
   *  Measured on a live board 2026-08-19, and the arithmetic is unmistakable: judge legs of 124.5s and
   *  118.0s, a tidy of 132.2s — each almost exactly 3 x their caller's ~45s. Those run on one serial
   *  chain, so a single stalled leg holds every utterance behind it, the backlog gate then skips
   *  everything that arrives, and the board stops moving. That is "sometimes it stales".
   *
   *  A deadline that a callee may silently multiply is not a deadline. */
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 3; attempt++) {
    const left = deadline - Date.now();
    // 2s is the floor worth trying at all; below that the attempt would time out before the model
    // could answer, and burn the tokens anyway.
    if (left < 2000) break;
    try {
      const out = await chatOnce(messages, budget, left, opts);
      if (out.length > 10) return out;
      if (opts.spend) opts.spend.empties += 1;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (opts.spend) opts.spend.empties += 1;
      // A refusal is deterministic for the same input. Retrying buys the identical answer at the
      // identical price, twice, while the board sits frozen.
      if ((lastErr as Error & { refused?: boolean }).refused) throw lastErr;
    }
    budget *= 2;
  }
  if (lastErr) throw lastErr;
  return "";
}

async function chatOnce(messages: Msg[], maxTokens: number, timeoutMs: number, opts: CallOpts): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: headers(),
      signal: ctl.signal,
      body: JSON.stringify({
        model: opts.model || MODEL,
        max_tokens: maxTokens,
        // `enabled: false`, NOT `exclude: true`. They read the same and are not the same: exclude only
        // HIDES the reasoning, and you still wait for it and still pay for it. Measured 2026-08-12 on
        // one identical judge-shaped prompt:
        //
        //   deepseek-v4-flash   exclude:true   15.00s   76 reasoning tokens   $0.000069
        //                       enabled:false   3.34s    0 reasoning tokens   $0.000029
        //   gemini-3-flash      exclude:true    1.83s    0 reasoning tokens
        //                       enabled:false   1.79s    0 reasoning tokens
        //
        // So this one word was a 4.5x latency penalty and a 2.4x cost penalty on a reasoning model,
        // and nothing at all on a model that wasn't reasoning anyway. That asymmetry is what made the
        // first A/B look like "deepseek is slow": it was not comparing two models, it was comparing
        // one model thinking against one not thinking.
        //
        // reasoning_effort:"low" is NOT the lighter option it sounds like — it ENABLES reasoning at
        // low effort, measured worse than exclude on both models (30.3s / 4.9s). Don't reach for it.
        reasoning: { enabled: false },
        messages,
        ...(opts.extra ?? {}),
      }),
    });
    const raw = await res.text();
    // strict-off equivalent: the reasoning field can carry raw newlines that break strict parsers,
    // and we've already been bitten by that once.
    const data = JSON.parse(raw);
    if (data.error) throw new Error(`OpenRouter: ${JSON.stringify(data.error).slice(0, 300)}`);
    bill(opts.spend, data, t0);
    const choice = data.choices?.[0];
    const content = (choice?.message?.content ?? "").trim();
    // The distinction that took several rounds to find: a budget failure and a considered "nothing to
    // say" are the same 200 with the same empty content. finish_reason tells them apart, so say so
    // out loud with the token count rather than letting a caller read silence as an answer.
    if (!content && choice?.finish_reason === "length") {
      throw new Error(
        `max_tokens exhausted before any content: budget ${maxTokens}, ` +
        `${data.usage?.completion_tokens ?? "?"} completion tokens burned on reasoning`,
      );
    }
    /** ⚠️ A REFUSAL IS NOT A SHORT ANSWER, AND RETRYING IT IS PURE LATENCY.
     *
     *  chat() retries a reply under 10 characters, on the correct theory that it means the budget was
     *  too small. But a model that DECLINES — because the transcript contains swearing, which real
     *  meetings are full of — also returns a short reply, with finish_reason "content_filter" or a
     *  plain "stop". Doubling the token budget cannot talk it into answering: the input is identical,
     *  so the refusal is identical, three times over.
     *
     *  That is the reported "swear words freeze the canvas": one profane utterance turned a 3s judge
     *  into the full retry ladder, and on a serial chain that stalls every utterance behind it.
     *  Marked so chat() can stop instead of trying twice more for the same answer. */
    if (choice?.finish_reason === "content_filter" || (content.length <= 10 && choice?.finish_reason === "stop")) {
      const e = new Error(`model declined or returned nothing (finish_reason=${choice?.finish_reason})`);
      (e as Error & { refused?: boolean }).refused = true;
      throw e;
    }
    return content;
  } finally {
    clearTimeout(t);
  }
}

/** Charge one response to an accumulator.
 *
 *  Called BEFORE the finish_reason check on purpose. A budget-exhausted call throws, but the tokens
 *  were really burned and OpenRouter really charges for them — that waste is the most interesting
 *  number on the scorecard, so it must not vanish just because the call ended in an exception. A
 *  request that failed at the transport layer never reaches here, which is also correct: nothing was
 *  billed. */
function bill(spend: Spend | undefined, data: unknown, t0: number) {
  if (!spend) return;
  const usage = (data as { usage?: { cost?: unknown } } | null)?.usage;
  spend.cost += Number(usage?.cost) || 0;
  spend.ms += Date.now() - t0;
  spend.calls += 1;
}

/** What one audio chunk produced. */
export type TranscriptResult = {
  /** Speaker-prefixed where the engine gives us speakers, one line per turn otherwise. */
  lines: string[];
  /** Distinct speaker labels the engine actually returned.
   *
   *  Expect 0. Diarization does not survive OpenRouter's `{text, usage}` response shape — probed
   *  directly and closed in §17 — so this stays a number rather than a boolean mainly to catch the
   *  day a provider starts answering. Real speaker attribution comes from Recall.ai's
   *  per-participant streams, which carry the speaker's name, not from anything inferred here. */
  speakers: number;
  /** Which request shape the provider accepted, e.g. "verbose_json+provider". The fallback ladder in
   *  transcribeSTT is how we discover what a given STT model supports; this is what it discovered. */
  profile: string;
};

/** One audio chunk → lines.
 *
 *  `format` exists because the two producers speak different codecs and neither should have to
 *  convert. The A/B harness slices an mp3 with ffmpeg; the live path receives 16 kHz mono S16LE
 *  straight from Recall and wraps it in a 44-byte WAV header, which keeps ffmpeg out of the hot path
 *  entirely — no subprocess per utterance on a 2-vCPU box. */
export async function transcribe(
  engine: TranscribeEngine,
  audio: Buffer,
  keyterms: string[] = [],
  spend?: Spend,
  format: string = "mp3",
  prompt?: string,
): Promise<TranscriptResult> {
  return transcribeSTT(engine, audio, keyterms, spend, format, prompt);
}

/** OpenRouter's dedicated transcription endpoint.
 *
 *  Walks a fallback ladder instead of assuming a request shape, because support is per-provider and
 *  largely undocumented per-model: `timestamp_granularities` works on OpenAI-compatible providers and
 *  400s on Deepgram and Parakeet. The rung that worked is reported, so a run tells you what the
 *  provider actually accepted rather than what its docs claim.
 *
 *  ⚠️ The provider passthrough is NOT a route to provider-native features. Probed directly on
 *  2026-08-10: the same audio sent with and without `provider.options` came back byte-identical. The
 *  block is accepted and then ignored — a 200 with a silently dropped capability. Diarization was
 *  requested here until that probe closed the question; speaker identity now comes from Recall.ai's
 *  per-participant streams instead. The keyterm rung is kept because it costs nothing when it works
 *  and would matter on a provider that honours it — not as evidence that this one does. */
async function transcribeSTT(
  engine: Extract<TranscribeEngine, { kind: "stt" }>,
  audio: Buffer,
  keyterms: string[],
  spend?: Spend,
  format: string = "mp3",
  prompt?: string,
): Promise<TranscriptResult> {
  // The ear is chosen by model id rather than by a separate config knob, so there is exactly one
  // place to change it and nothing can disagree about which provider is listening.
  if (engine.model.startsWith("blaze")) return transcribeBlaze(engine, audio, format, spend);
  // `omni:` prefix rather than a separate config field, for the same reason the ear is chosen by model
  // id everywhere else: one string decides the path, so nothing can disagree about which is in use.
  /** ⚠️ THE OMNI EAR GETS THE FULL VOCABULARY, not just the recent-lines glossary.
   *
   *  This passed `keyterms` — at most 24 capitalised words scraped from the last 60 transcript lines.
   *  Meanwhile `prompt` carries asrPrompt()'s 132 vault-derived terms, the entire point of the
   *  launchd sync job, built precisely BECAUSE the ASR biasing parameters were proved inert. Handing
   *  the omni model the small list meant the one ear that actually honours a glossary was the one ear
   *  not receiving it. `prompt` first, keyterms as a supplement. */
  if (engine.model.startsWith("omni:")) {
    /** ⚠️ BARE TERMS ONLY — NEVER THE asrPrompt SENTENCE.
     *
     *  asrPrompt() returns "This is a product meeting. Expect these names and terms: …", which is
     *  correct for a whisper-style decoder prompt, where a prompt is a style hint. Put the same
     *  sentence in an omni model's SYSTEM MESSAGE and it becomes a premise the model will happily
     *  continue: on a near-silent chunk it replied
     *
     *    "This is a product meeting. Hôm nay chúng ta sẽ review lại Minami Dashboard và thảo luận
     *     về commerce360 direction…"
     *
     *  — a meeting that never happened, assembled from the vault vocabulary, indistinguishable from
     *  real speech by the time it reaches the judge. That is the "context leaked / irrelevant
     *  mindmap" failure. Terms are a LIST here, never prose. */
    const bare = (prompt ?? "").replace(/^[^:]*:\s*/, "").replace(/\.$/, "");
    const terms = [...new Set([...bare.split(/,\s*/).filter(Boolean), ...keyterms])];
    return transcribeOmni(engine, audio, format, terms, spend);
  }

  const base: Record<string, unknown> = {
    model: engine.model,
    // Base64 bytes, NOT a data URI — the endpoint rejects the latter.
    input_audio: { data: audio.toString("base64"), format },
    // A REAL prompt, not provider.options.keyterm. The keyterm passthrough was probed and proved to be
    // silently ignored by OpenRouter (§17), so the glossary this pipeline has always computed never
    // reached the decoder. `prompt` is a first-class field on /audio/transcriptions and is the only
    // channel that actually biases the transcription toward words the model has never seen.
    ...(prompt ? { prompt } : {}),
  };
  if (engine.language) base.language = engine.language;

  // ⚠️ THE PROVIDER RUNG IS GONE, and removing it is a straight saving.
  //
  // It sent `provider.options.keyterm` hoping to bias the decode. That passthrough was PROVED inert:
  // probed 2026-08-10, the same audio with and without the block returned byte-identical bodies.
  // So the first rung was a request identical to the second in everything but a field the API ignores
  // — and because bill() charges each rung, every chunk that failed the first rung paid for the same
  // call twice. On whisper at $0.09/audio-hour that was noise; on chirp-3 at $0.96 it is not.
  //
  // The keyterms it was trying to carry now reach the model properly, as the `prompt` field set by the
  // caller — which is a real parameter rather than a hopeful one. See canvas-vocab.mjs.
  void keyterms;

  const ladder = [
    { profile: "verbose_json", body: { ...base, response_format: "verbose_json" } },
    { profile: "json", body: base },
  ];

  let lastErr = "";
  for (const rung of ladder) {
    const t0 = Date.now();
    try {
      const ctl = new AbortController();
      // 60s is the endpoint's own upstream compute ceiling. Waiting longer cannot help.
      const t = setTimeout(() => ctl.abort(), 60_000);
      let data: any;
      try {
        const res = await fetch(`${BASE}/audio/transcriptions`, {
          method: "POST", headers: headers(), signal: ctl.signal, body: JSON.stringify(rung.body),
        });
        data = JSON.parse(await res.text());
      } finally {
        clearTimeout(t);
      }
      if (data?.error) throw new Error(JSON.stringify(data.error).slice(0, 200));
      bill(spend, data, t0);
      const { lines, speakers } = linesFromSTT(data);
      if (lines.length) return { lines, speakers, profile: rung.profile };
      lastErr = "empty transcript";
      if (spend) spend.empties += 1;
    } catch (e) {
      lastErr = e instanceof Error ? e.message.slice(0, 160) : "unknown";
    }
  }
  throw new Error(`stt: every request shape failed — last: ${lastErr}`);
}

/** A transcription response → display lines, keeping speakers when we are given them. */
function linesFromSTT(data: unknown): { lines: string[]; speakers: number } {
  const d = data as { segments?: unknown; text?: unknown } | null;
  const segments = Array.isArray(d?.segments) ? (d.segments as Record<string, unknown>[]) : [];
  const speakerSet = new Set<string>();

  // Segments are only worth using when they carry SPEAKERS. Measured against grok-stt-1.0 on
  // 2026-08-10: a 15s chunk came back as exactly one segment spanning the whole clip with no speaker
  // field, so taking the segment path would emit the entire chunk as a single unbroken line. Falling
  // through to toLines() splits it into readable sentences instead.
  if (segments.length && segments.some((s) => (s?.speaker ?? s?.speaker_id ?? s?.speaker_label) != null)) {
    const out: string[] = [];
    let current: { who: string | null; text: string } | null = null;
    for (const s of segments) {
      const text = String(s?.text ?? "").trim();
      if (!text) continue;
      // Providers spell this field differently; take whichever is present.
      const raw = s?.speaker ?? s?.speaker_id ?? s?.speaker_label;
      const who = raw === undefined || raw === null ? null : String(raw);
      if (who !== null) speakerSet.add(who);
      // Merge consecutive segments from one speaker: segment boundaries are acoustic, not
      // conversational, and one line per segment reads as stutter.
      if (current && current.who === who) current.text += ` ${text}`;
      else { if (current) out.push(renderTurn(current)); current = { who, text }; }
    }
    if (current) out.push(renderTurn(current));
    if (out.length) return { lines: out, speakers: speakerSet.size };
  }

  return { lines: toLines(String(d?.text ?? "")), speakers: 0 };
}

const renderTurn = (c: { who: string | null; text: string }) =>
  c.who === null ? c.text : `${/^\d+$/.test(c.who) ? `Speaker ${c.who}` : c.who}: ${c.text}`;

/** Text → readable lines. A bare ASR transcript comes back as one wall of text — a 15s clip probed
 *  directly returned a single segment spanning the whole clip — so break it on sentence ends and
 *  pair them up. Without this the entire chunk renders as one unbroken line. */
function toLines(text: string): string[] {
  const raw = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 1);
  if (raw.length > 1) return raw;
  const sentences = (raw[0] ?? "").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) out.push(sentences.slice(i, i + 2).join(" "));
  return out.filter((l) => l.length > 1);
}

/* ── transcript → canvas actions ─────────────────────────────────────────────────────────────── */

export type RawAction = {
  /** card = add something new. revise/merge only appear on a SERIAL feed, where the board the model
   *  is looking at is genuinely the board as it stands. */
  op: "card" | "revise" | "merge";
  /** revise/merge: the EXACT existing label being changed or folded away. */
  target?: string;
  /** merge: the exact existing label to fold `target` into. */
  into?: string;
  /** Cluster name, not an id — see deriveActions for why this matters. */
  topic?: string;
  /** The EXACT label of an existing card this one hangs under, when it is a detail of that card
   *  rather than a new point under the topic. This is what gives the board depth: without it every
   *  card is a sibling and the map is two levels deep however it is drawn. */
  under?: string;
  /** Label of another card this one relates to. Resolved server-side; unresolvable ones are dropped
   *  rather than guessed at. */
  relatesTo?: string;
  relation?: string;
  kind?: string;
  label?: string;
  detail?: string;
  state?: string;
  /** A reaction on THIS card, when the moment deserves one.
   *
   *  Reactions used to come only from findRelations — the once-per-run whole-board pass — which the
   *  live ingest route deliberately never calls. So a real meeting produced zero reactions and the
   *  full-screen cut scene could never fire, no matter what anyone said or agreed to. Tested: anh
   *  explicitly staged an agreement with another participant and nothing happened.
   *
   *  Emitting it HERE fixes that at the only point that knows: the judge is already reading the
   *  utterance, so the moment worth reacting to is in front of it. It also costs nothing extra — one
   *  optional field on a call that was happening anyway, rather than a second pass. */
  emoji?: string;
  tags?: string[];
  toRef?: string;
  edge?: string;
  /** VERBATIM line this came from. The server rejects the action if this text isn't in the
   *  transcript — which makes fabricating a decision a validation failure rather than a matter of
   *  the model choosing to behave. */
  source?: string;
};

const SYSTEM = `You watch a live conversation transcript and maintain a visual canvas of it.

LANGUAGE — write every label and detail in THE LANGUAGE THE PEOPLE ARE SPEAKING.
Match the transcript. Vietnamese in, Vietnamese out. English in, English out. If the conversation
mixes both, follow whichever the specific point was made in — do not normalise a meeting into one
language, and never translate into a third one.

This is not a preference. The board is screen-shared back to the people who are talking, so a card
they cannot read is worse than no card: it is their own words returned to them as noise.

You do NOT write to the canvas directly. You return operations and the server applies them.

OPERATIONS
  {"op":"card","topic":"Scope","kind":"...","label":"...","detail":"...","source":"...",
   "relatesTo":"<label of another card>","relation":"blocks|depends|answers|contradicts",
   "emoji":"<one of 🔥 😮 💡 ❓ 👏 🤝 💯 ✅, or null>"}

REACTIONS — "emoji" marks a MOMENT, and the room sees it full-screen
A card with an emoji takes over the whole shared screen for a few seconds. That is the most
memorable thing this board does, and also the easiest thing to ruin by overusing. So:

  🤝 people just AGREED on something, or settled a disagreement
  💯 strong, explicit agreement — "exactly", "yes, that's it", several people at once
  ✅ something was decided or closed out
  🔥 the strongest claim or best idea so far
  💡 a genuinely new idea nobody had said yet
  😮 something surprising — a number, a risk, a reversal
  👏 someone did something worth marking
  ❓ a real question left hanging

Set it to null on almost every card. Roughly one card in six should carry one — an emoji on every
card means none of them is a moment. But DO set it when people actually agree: that is the single
most common thing worth marking in a meeting, and a board that never reacts to an agreement is
missing the moment it exists to catch.

"topic" is the SHORT NAME of the cluster this card belongs to.

TOPICS MUST BE BROAD BUT NEVER VAGUE — and this is the single most common way this board goes wrong.
A whole conversation should end up with roughly 3 to 6 of them, not one per fact. "OpenAI", not
"OpenAI Lumen" and "OpenAI Sore" and "OpenAI Models" — one subject seen three times. Before inventing
a name, check KNOWN TOPICS and reuse anything that could plausibly hold this card.

⚠️ A TOPIC MUST NAME THE SUBJECT, NOT THE ACTIVITY. These are BANNED as topic names, in any language,
because they describe what a meeting IS rather than what it is ABOUT:
  "Thảo luận chung", "Khởi động", "Triển khai", "Chung", "Tổng quan", "Nội dung", "Vấn đề",
  "General", "Discussion", "Overview", "Kickoff", "Intro", "Misc", "Notes", "Meeting", "Updates"
Every meeting is a discussion; naming a cluster "Discussion" tells the reader nothing and makes the
board unreadable at a glance. Name the THING: the product, the customer, the system, the decision.
"Vector search", "QSortby pricing", "Onboarding flow" — a noun someone could search for later.

If you genuinely cannot tell what the subject is yet, put the card under the MEETING CONTEXT topic
given below rather than inventing a placeholder you will be stuck with for the rest of the call.

"relatesTo" points at ANOTHER card by its EXACT label — either one you are creating in this same
reply, or one listed under KNOWN CARDS. The relationships are what make this a map instead of a list,
so LOOK for them every time:

  answers      this card resolves a question raised by that one
  blocks       this thing stops that thing happening
  depends      this only works if that holds
  contradicts  these two cannot both be true, or someone argued the opposite

A conversation that covers several subjects almost always contains a few of these — a constraint
that undercuts a plan, a fact that answers an earlier question, two speakers disagreeing. Expect to
find at least one per handful of cards. Don't force one onto every card, but don't return a board
with none either: a board with no connections means you didn't look.

LABELS ARE HEADLINES, DETAILS ARE THE SENTENCE
The label is read from across a room on a shared screen, so it must survive a glance:

  label   at most ~8 words. A noun phrase or a claim, no leading "Phạm Đức Toàn nói rằng…", no
          "Câu hỏi về…", no restating the kind that is already printed on the card. Write
          "Vector search đắt hơn dự tính", not "Thảo luận về việc vector search có thể đắt hơn".
  detail  one sentence of substance — the number, the reason, the condition. Not a paraphrase of
          the label with more words. If the detail says nothing the label did not, omit it.

A board of twenty full sentences cannot be read while someone is still talking, which is the only
moment it exists for.

CARD KINDS — pick the closest; when nothing else fits, use "note"
  note         a substantive statement: a fact, a number, a claim, an argument someone made
  decision     something settled
  action       something someone will do
  question     something asked and not yet answered
  requirement  something needed or asked for
  risk         something that could go wrong
  milestone    a date or checkpoint
  quote        a striking line worth showing verbatim
  aside        small talk, a joke, a personal aside, a tangent — see the rule below

SMALL TALK HAS ITS OWN LANE, AND IT MATTERS
Put every "aside" card under the topic "Bên lề" (Vietnamese) or "Small talk" (English) — never under
a subject topic. Two reasons, and the second is the important one:

  1. It keeps the subject clusters clean, so the board reads at a glance.
  2. It does NOT throw the human part away. Meetings are relationships: someone's kid is sick,
     someone just shipped something, a joke lands. That is what makes the next call easier, and a
     board that erases it is a transcript of a machine talking to a machine. Keep it — just keep it
     somewhere else.

Do not use "aside" as a dumping ground for substance you could not classify. A fact is a note.

YOUR DEFAULT IS TO CAPTURE. Most of what people say IS substance: facts, numbers, opinions,
arguments, announcements. If a passage says something, it earns a card — usually a "note".
Return an empty list ONLY for genuine filler: greetings, "um", repetition of the previous line,
or someone agreeing without adding anything.

If the board is empty, your first job is to create at least one topic. Everything hangs off one.

RULES
1. Every card MUST carry "source": the sentence from the transcript it came from, copied as closely
   as you can. No source, no card.
2. label is ONE tight line, max ~9 words. detail is one sentence saying why it matters.
3. Use the SPELLINGS in KNOWN NAMES for any name that appears there. The audio is unclear on proper
   nouns and consistency matters more than being right — four spellings of one product become four
   separate clusters on the board.
4. Do not summarise. React only to the lines given.
5. Return between 1 and 6 cards. This is one minute of speech, not a document.

Return ONLY JSON: {"actions":[...]}.`;

/** The shape the RULES above describe in prose, for the arms that ask the provider to enforce it.
 *
 *  Note the shape of `required`: strict mode demands that EVERY key in `properties` also appear in
 *  `required`, so an optional field is expressed by allowing null rather than by leaving the key out.
 *  Getting this wrong is a 400 at request time, not a quiet degradation. Nulls need no special
 *  handling downstream — `state: null` fails the STATES lookup and `detail: null` short-circuits the
 *  optional chain, both of which already mean "absent". */
const ACTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "topic", "kind", "label", "detail", "state", "source", "relatesTo", "relation", "emoji"],
        properties: {
          op: { type: "string", enum: ["card"] },
          topic: { type: "string" },
          kind: {
            type: "string",
            enum: ["note", "decision", "action", "question", "requirement", "risk", "milestone", "quote", "aside"],
          },
          label: { type: "string" },
          detail: { type: ["string", "null"] },
          state: { type: ["string", "null"], enum: ["proposed", "agreed", "done", "blocked", "open", null] },
          source: { type: "string" },
          relatesTo: { type: ["string", "null"] },
          relation: { type: ["string", "null"], enum: ["answers", "blocks", "depends", "contradicts", null] },
          // Strict schema requires EVERY property in `required`; optionality is expressed as a null
          // union, never by omitting the key. Getting that wrong is a 400 at request time.
          emoji: { type: ["string", "null"], enum: ["🔥", "😮", "💡", "❓", "👏", "🤝", "💯", "✅", null] },
        },
      },
    },
  },
} as const;

export async function deriveActions(
  knownTopics: string[],
  lines: string,
  glossary: string[] = [],
  knownCards: string[] = [],
  opts: { cfg?: CanvasMode["derive"]; spend?: Spend; revise?: boolean; context?: string } = {},
): Promise<RawAction[]> {
  // STATELESS per chunk. Previously each call needed the board as it stood after the previous chunk,
  // which forced derivation to run strictly in sequence — measured at 10-30s each, so 24 minutes of
  // audio meant ~6 minutes of derivation no matter how fast any single call got. Naming topics as
  // strings removes that dependency entirely and lets every chunk be judged at once.
  /** ⚠️ THE JUDGE USED TO START EVERY CALL BLIND. It saw ten seconds of speech with no idea whose
   *  meeting this was or what it was for, so the first topic it invented came from small talk —
   *  "Khởi động", "Thảo luận chung" — and that placeholder then anchored the whole board, because
   *  later cards are told to reuse existing topics before making new ones. The first thirty seconds
   *  of a call were deciding the shape of the next hour.
   *
   *  The context anh types (or picks from a Second Brain project) before dialling in is worth more
   *  than any amount of prompt tuning: it names the subject before the first word is spoken. */
  const user =
    (opts.context ? `MEETING CONTEXT — what this call is about. Use these words for topic names.\n${opts.context}\n\n` : "") +
    (knownTopics.length ? `KNOWN TOPICS — reuse these names when they fit\n${knownTopics.join(", ")}\n\n` : "") +
    (knownCards.length
      ? `${opts.revise ? "CARDS ON THE BOARD — you may point relatesTo at these, revise or merge them, and hang new cards UNDER them" : "CARDS ON THE BOARD — point relatesTo or under at any of these"}\n${knownCards.slice(-25).join("\n")}\n\n`
      : "") +
    `NESTING — this is a MIND MAP, so say where a card belongs.
Set "under" to the EXACT label of an existing card when the new one is a detail, consequence,
example, objection or qualification OF that card. Set "topic" instead when it is a fresh point
about the subject. A card with neither hangs directly off its topic, which is the right answer for
the first card of a thread and the wrong answer for the fourth in a row.

  "the pilot is six weeks"                    → topic: Timeline
  "six weeks because the budget closes in Q3" → under: "the pilot is six weeks"
  "which merchant do we start with?"          → topic: Scope

People develop one idea for a while before moving on, so consecutive cards are USUALLY nested and
only occasionally siblings. A board where nothing is nested is a board that recorded a list.\n\n` +
    (glossary.length ? `KNOWN NAMES — use these spellings\n${glossary.join(", ")}\n\n` : "") +
    (opts.revise
      ? `THIS IS A LIVE FEED. You are hearing the meeting IN ORDER, and the cards listed above are
the board as it stands right now — everything earlier audio produced. New context routinely proves
an earlier card wrong, vague, or a duplicate. Fix the board rather than piling another card beside it:

  {"op":"revise","target":"<exact existing label>","label":"<better label>","detail":"...","state":"..."}
  {"op":"merge","target":"<exact existing label>","into":"<exact existing label>"}

REVISE when this chunk makes an existing card clearer, sharper, or corrects it. Speech-to-text
mangles names and numbers on first mention and usually gets them right the second time, and people
routinely start a thought vaguely and only land it a minute later. Both are revisions, not new cards.
MERGE when two cards on the board turned out to be the same point said twice.
Name a target EXACTLY as it appears above or the action is discarded. Prefer revising an existing
card over adding one that is nearly the same.\n\n`
      : "") +
    `TRANSCRIPT\n${lines}`;

  const extra: Record<string, unknown> = {};
  if (opts.cfg?.strictSchema) {
    // Makes a malformed reply impossible rather than something we retry our way out of — which is
    // what the `attempt` loop below exists for, and why this arm rarely uses its second pass.
    extra.response_format = {
      type: "json_schema",
      json_schema: { name: "canvas_actions", strict: true, schema: ACTIONS_SCHEMA },
    };
  }
  if (opts.cfg?.latencyRouting) {
    // Rolling 5-minute percentiles, so this deprioritises an endpoint that is slow RIGHT NOW rather
    // than one that was slow last week. Fallbacks stay on: a preference, not a hard filter.
    extra.provider = { sort: "latency", preferred_max_latency: { p50: 1, p90: 3 } };
  }

  const deadline = Date.now() + 45_000;
  let lastErr = "";
  for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt++) {
    try {
      const out = await chat(
        [{ role: "system", content: SYSTEM },
         { role: "user", content: attempt ? `${user}\n\nYour last reply was invalid (${lastErr}). Return ONLY the JSON object.` : user }],
        // Generous headroom above the judge's reasoning tokens. A budget below what the model spends
        // thinking returns an empty board, not an error — see chat().
        6000,
        Math.max(8000, deadline - Date.now()),
        { model: opts.cfg?.model, extra, spend: opts.spend },
      );
      const first = out.indexOf("{");
      const last = out.lastIndexOf("}");
      if (first < 0 || last <= first) throw new Error("no JSON object in reply");
      const parsed = JSON.parse(out.slice(first, last + 1));
      if (!Array.isArray(parsed.actions)) throw new Error("no actions array");
      return parsed.actions as RawAction[];
    } catch (e) {
      lastErr = e instanceof Error ? e.message.slice(0, 80) : "unknown";
    }
  }
  return [];
}

/** Proper nouns seen so far, so later chunks spell them the way earlier ones did.
 *
 *  The audio gives no ground truth for invented names — the same product came back as Luna, Lumen
 *  and Luno across three runs of identical audio. We cannot make it CORRECT, but we can make it
 *  CONSISTENT, and consistency is what actually matters here: four spellings of one product become
 *  four separate topics on the board, which looks broken in a way a single odd spelling never does.
 *
 *  Deliberately not a model call. It's a regex over text we already have. */
export function glossaryFrom(lines: string[], limit = 24): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    // Skip the speaker prefix, then take capitalised words that aren't sentence-initial.
    const body = line.replace(/^[^:]{0,30}:\s*/, "");
    for (const m of body.matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][a-zA-Z]{2,})\b/g)) {
      const w = m[1];
      if (STOP.has(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)          // said twice = probably a real name, not a one-off mishear
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

const STOP = new Set([
  "The", "This", "That", "There", "Then", "They", "Well", "And", "But", "But", "For", "You", "Your",
  "What", "When", "Where", "Who", "Why", "How", "Its", "It", "We", "Our", "His", "Her", "Their",
  "Speaker", "Yeah", "Okay", "Right", "Now", "Just", "Like", "One", "Two", "Three", "First",
]);

/** A dedicated pass that does ONE thing: find relationships across the finished board.
 *
 *  This started as an optional `relatesTo` field on each card and the model emitted it exactly zero
 *  times, however the prompt was worded. Optional structure buried inside a larger schema is
 *  evidently beyond this model — the same weakness behind its blank replies and invented kinds.
 *
 *  Making it a separate call fixes more than compliance, though. Relationships are a WHOLE-BOARD
 *  question: a card from minute one may be answered by one from minute eight, and per-chunk
 *  derivation cannot see across chunks by construction. One pass at the end sees everything, costs a
 *  single call, and is the only place this can be done properly. */
export async function findRelations(
  cards: { id: string; kind: string; label: string }[],
  opts: { cfg?: CanvasMode["derive"]; spend?: Spend; transcript?: string } = {},
): Promise<{
  links: { from: string; to: string; kind: string }[];
  reactions: { id: string; emoji: string }[];
}> {
  if (cards.length < 3) return { links: [], reactions: [] };

  const list = cards.map((c) => `${c.id} [${c.kind}] ${c.label}`).join("\n");
  const out = await chat(
    [
      {
        role: "system",
        content: `You find relationships and reactions on a board. Reply ONLY with JSON:
{"links":[{"from":"<id>","to":"<id>","kind":"answers|blocks|depends|contradicts"}],
 "reactions":[{"id":"<id>","emoji":"<one emoji>"}]}

LINKS
  answers      the first resolves a question posed by the second
  blocks       the first stops the second from happening
  depends      the first only holds if the second does
  contradicts  they cannot both be true, or they are two sides of an argument
Use ONLY ids from the list. Return 2 to 6 — the strongest, not every plausible pair. Two items merely
about the same subject is NOT a relationship; they are already grouped together.

REACTIONS — mark the moments a listener would react to. Use the transcript to judge tone, not just
the card text. Return 2 to 5, on the items that actually earned one:
  🤝 the speakers agreed on this        ⚡ someone pushed back or disagreed
  💡 a genuinely new idea landed        😮 a number or fact that surprised
  🔥 the strongest claim made           ❓ left hanging, nobody resolved it

These are what make the board feel like a conversation happened rather than minutes being taken, so
DO return some. A board with no reactions means you did not look for them.`,
      },
      { role: "user", content: `BOARD\n${list}${opts.transcript ? `\n\nTRANSCRIPT (for tone)\n${opts.transcript.slice(-4000)}` : ""}` },
    ],
    // Generous headroom above the judge's reasoning tokens. A budget below what the model spends
    // thinking returns an empty board, not an error — see chat().
    6000,
    240_000,
    { model: opts.cfg?.model, spend: opts.spend },
  );

  try {
    const first = out.indexOf("{");
    const last = out.lastIndexOf("}");
    if (first < 0 || last <= first) return { links: [], reactions: [] };
    const parsed = JSON.parse(out.slice(first, last + 1));
    const ids = new Set(cards.map((c) => c.id));
    const ok = new Set(["answers", "blocks", "depends", "contradicts"]);
    return {
      links: (parsed.links ?? [])
        .filter((l: { from: string; to: string; kind: string }) =>
          ids.has(l.from) && ids.has(l.to) && l.from !== l.to && ok.has(l.kind))
        .slice(0, 8),
      reactions: (parsed.reactions ?? [])
        .filter((r: { id: string; emoji: string }) => ids.has(r.id) && r.emoji && [...r.emoji].length <= 2)
        .slice(0, 6),
    };
  } catch (e) {
    // NOT SILENT. A malformed reply here is indistinguishable from "there were no relationships",
    // and this whole project's recurring failure has been exactly that shape: a clean log and an empty
    // result. If the relate pass is broken, the log has to say broken.
    console.error("[relate] unparseable reply:", e instanceof Error ? e.message : e);
    return { links: [], reactions: [] };
  }
}


/** Board tidy-up: revise and merge only, nothing new.
 *
 *  Offering `revise`/`merge` as extra ops inside deriveActions produced exactly zero of them across
 *  a full run — the same failure as offering `relatesTo` as an optional field, and for the same
 *  reason: a model given one job plus an optional second job does the first one. A pass that CANNOT
 *  add anything has no first job to retreat into.
 *
 *  Runs mid-meeting rather than at the end, because the point is watching the board get tidier while
 *  the conversation is still going — a cleanup after the last word is just post-processing. */
export async function refineBoard(
  cards: { id: string; label: string; detail?: string }[],
  recent: string,
  opts: { cfg?: CanvasMode["derive"]; spend?: Spend } = {},
): Promise<{
  revise: { id: string; label?: string; detail?: string }[];
  merge: { from: string; into: string }[];
  nest: { id: string; under: string }[];
}> {
  const empty = { revise: [], merge: [], nest: [] };
  if (cards.length < 3) return empty;

  const list = cards.map((c) => `${c.id} | ${c.label}${c.detail ? ` — ${c.detail}` : ""}`).join("\n");
  const out = await chat(
    [
      {
        role: "system",
        content: `You are tidying a live meeting board. You CANNOT add anything. Reply ONLY with JSON:
{"revise":[{"id":"<id>","label":"<better label>","detail":"<better detail>"}],
 "merge":[{"from":"<id>","into":"<id>"}],
 "nest":[{"id":"<id>","under":"<id>"}]}

NEST is the important one. This board is a MIND MAP and it is currently flat — every card is a
sibling of every other, which records a list and draws a fan. Find the cards that are really a
detail, consequence, example, objection or qualification OF another card, and say so.

  "six weeks because the budget closes in Q3"  nests under  "the pilot is six weeks"
  "98% of users never pay"                     nests under  "free tier shapes perception"

Never nest a card under its own descendant, and never under itself. A card already nested correctly
does not need repeating. Return 2 to 6 — conversations develop one idea at a time, so a dozen cards
almost always contain several of these; a board with nothing nested has not been read properly.

MERGE two cards when they are the same point recorded twice — the same decision worded differently,
the same question asked again, a card that is just a vaguer version of another. Keep the clearer one
as "into".

REVISE a card when the later transcript makes it wrong or fuzzy:
  · a name or number the transcriber mangled on first mention and got right later
  · a thought someone started vaguely and only landed properly a minute afterwards
  · a label that made sense alone but is ambiguous now other cards exist

Use ONLY ids from the list. Return {"revise":[],"merge":[]} if the board is genuinely already clean —
but read it properly first: a board of a dozen cards written a few seconds apart by someone hearing
the meeting for the first time usually has at least one duplicate or one fuzzy label.`,
      },
      { role: "user", content: `BOARD\n${list}\n\nRECENT TRANSCRIPT\n${recent.slice(-2500)}` },
    ],
    5000,
    120_000,
    { model: opts.cfg?.model, spend: opts.spend },
  );

  try {
    const first = out.indexOf("{");
    const last = out.lastIndexOf("}");
    if (first < 0 || last <= first) return empty;
    const parsed = JSON.parse(out.slice(first, last + 1));
    const ids = new Set(cards.map((c) => c.id));
    return {
      revise: (parsed.revise ?? [])
        .filter((r: { id: string }) => ids.has(r.id))
        .slice(0, 6),
      merge: (parsed.merge ?? [])
        .filter((m: { from: string; into: string }) => ids.has(m.from) && ids.has(m.into) && m.from !== m.into)
        .slice(0, 4),
      nest: (parsed.nest ?? [])
        .filter((n: { id: string; under: string }) => ids.has(n.id) && ids.has(n.under) && n.id !== n.under)
        .slice(0, 8),
    };
  } catch (e) {
    // NOT SILENT — same reason as the relate pass. "0 merged, 0 revised" currently reads as "the board
    // was already tidy", and would read identically if every single reply were unparseable. Those are
    // opposite facts and must not print the same way.
    console.error("[tidy] unparseable reply:", e instanceof Error ? e.message : e);
    return empty;
  }
}
