// OpenRouter client for the meeting canvas.
//
// Two jobs, deliberately two calls: audio → transcript, then transcript → canvas actions. Doing it
// in one call is cheaper and hears tone, but you never see WHAT it heard — so a wrong card becomes
// unexplainable. The transcript is the artifact that makes every downstream mistake debuggable.
//
// Measured on this model 2026-08-09: ~13s per 60s of audio, 1,050,000 token context,
// $0.14/M in · $0.28/M out. Reasoning is excluded — it was the entire source of latency variance
// (2.0s / 7.4s / 2.7s on identical input, tracking reasoning length, not network).
//
// There are now TWO ways to do the first job, and comparing them is the point of the A/B arms in
// lib/canvas-modes.ts (§17):
//
//   chat  audio into /chat/completions — a general model writing out what it hears. What shipped.
//   stt   audio into /audio/transcriptions — a model that only does ASR. This endpoint did not exist
//         when the chat path was written. Batch-only: 60s upstream compute ceiling, base64 or ≤25MB
//         multipart, no URLs, no streaming.
//
// Every call also reports what it cost and how long it took, because two paths that can't be
// compared are just two paths. OpenRouter always returns `usage.cost` now — the old
// `usage: {include: true}` flag is deprecated and has no effect.

import type { CanvasMode, TranscribeEngine } from "./canvas-modes";

const BASE = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const MODEL = process.env.OPENROUTER_MODEL || "xiaomi/mimo-v2.5";

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

/** Per-call knobs the A/B arms differ on. All optional, so existing call sites are unchanged. */
type CallOpts = {
  /** Which model. Defaults to OPENROUTER_MODEL — arm C overrides it for judging only. */
  model?: string;
  /** Extra body fields: response_format, provider routing. */
  extra?: Record<string, unknown>;
  /** Accumulator to bill this call into. */
  spend?: Spend;
};

/** A completion, retried when the model returns NOTHING.
 *
 *  mimo intermittently answers with a valid 200 whose message.content is null — it spent the turn
 *  reasoning and emitted no answer, and `exclude` hides the reasoning so the reply just looks blank.
 *  Roughly one call in three on this workload, on BOTH the audio and the judging path.
 *
 *  This was the single most expensive bug in the pipeline, precisely because it was invisible: an
 *  empty reply is indistinguishable from "the model decided nothing was worth keeping". It produced
 *  chunks with no transcript, chunks with no cards, and a canvas that looked slow rather than
 *  broken — and it sent me optimising latency for several rounds when the real problem was that a
 *  third of the calls were returning nothing at all.
 *
 *  Retrying here, once, covers every caller. A blank reply is never an answer. */
async function chat(messages: Msg[], maxTokens: number, timeoutMs = 240_000, opts: CallOpts = {}): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await chatOnce(messages, maxTokens, timeoutMs, opts);
    if (out.length > 10) return out;
    if (opts.spend) opts.spend.empties += 1;
  }
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
        // Turning this off is why the tail is predictable. Re-enable only with a measured reason.
        reasoning: { exclude: true },
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
    return (data.choices?.[0]?.message?.content ?? "").trim();
  } finally {
    clearTimeout(t);
  }
}

/** Charge one response to an accumulator. A call that threw never gets here, which is deliberate:
 *  OpenRouter doesn't bill a request it failed, so counting it would overstate the arm's cost. */
function bill(spend: Spend | undefined, data: unknown, t0: number) {
  if (!spend) return;
  const usage = (data as { usage?: { cost?: unknown } } | null)?.usage;
  spend.cost += Number(usage?.cost) || 0;
  spend.ms += Date.now() - t0;
  spend.calls += 1;
}

/** One audio chunk → verbatim text.
 *
 *  Retries on an EMPTY reply. mimo intermittently returns a perfectly valid 200 whose
 *  message.content is null — it spent the turn reasoning and emitted no answer, and `exclude` then
 *  hides the reasoning so the response just looks blank. Roughly one chunk in three here.
 *
 *  This was invisible and expensive: the chunk silently produced no transcript, so no cards, and the
 *  canvas simply waited for the next chunk — which read as "the whole thing is slow" rather than
 *  "one call came back empty". Never treat a blank reply as an answer. */
export type TranscriptResult = {
  /** Speaker-prefixed where the engine gives us speakers, one line per turn otherwise. */
  lines: string[];
  /** Distinct speaker labels the engine actually returned.
   *
   *  0 on the chat path is the honest answer, not a bug: that path has no diarization at all, so the
   *  "Speaker 1:" prefixes it writes are the model's invention. 0 on the stt path means diarization
   *  did not survive OpenRouter's `{text, usage}` response shape — the open question in §17, and the
   *  reason this is a number rather than a boolean. */
  speakers: number;
  /** Which request shape the provider accepted, e.g. "verbose_json+provider". The fallback ladder in
   *  transcribeSTT is how we discover what a given STT model supports; this is what it discovered. */
  profile: string;
};

/** One audio chunk → lines, by whichever engine this arm uses. */
export async function transcribe(
  engine: TranscribeEngine,
  mp3: Buffer,
  keyterms: string[] = [],
  spend?: Spend,
): Promise<TranscriptResult> {
  return engine.kind === "stt"
    ? transcribeSTT(engine, mp3, keyterms, spend)
    : transcribeChat(engine.model, mp3, spend);
}

async function transcribeChat(model: string, mp3: Buffer, spend?: Spend): Promise<TranscriptResult> {
  // No retry here — chat() already retries a blank reply. Two layers would multiply into nine calls
  // for one chunk and blow the time budget on the exact failure they exist to absorb.
  const text = await chat(
    [{
      role: "user",
      content: [
        {
          type: "text",
          text:
            "Transcribe this audio verbatim. Output ONLY the transcript, no commentary, no summary. " +
            "Put each speaker turn on its own line, prefixed with a short speaker label and a colon. " +
            "If a word is unclear, transcribe your best guess rather than omitting it.",
        },
        { type: "input_audio", input_audio: { data: mp3.toString("base64"), format: "mp3" } },
      ],
    }],
    2000,
    240_000,
    { model, spend },
  );
  return { lines: toLines(text), speakers: 0, profile: "chat" };
}

/** The challenger path: OpenRouter's dedicated transcription endpoint.
 *
 *  Walks a fallback ladder instead of assuming a request shape, because support is per-provider and
 *  largely undocumented per-model: `timestamp_granularities` works on OpenAI-compatible providers and
 *  400s on Deepgram and Parakeet, and whether a provider-native flag like diarization survives the
 *  trip through OpenRouter is exactly what this arm exists to find out. The rung that worked is
 *  reported, so a single run answers the question rather than needing a separate experiment. */
async function transcribeSTT(
  engine: Extract<TranscribeEngine, { kind: "stt" }>,
  mp3: Buffer,
  keyterms: string[],
  spend?: Spend,
): Promise<TranscriptResult> {
  const base: Record<string, unknown> = {
    model: engine.model,
    input_audio: { data: mp3.toString("base64"), format: "mp3" },
  };
  if (engine.language) base.language = engine.language;

  // Provider-specific passthrough. Keyterms are the REAL fix for Luna/Lumen/Luno: a name corrected at
  // the ASR is a name transcribed right, where the glossary in the judging prompt can only patch the
  // spelling after the mishearing has already happened.
  const providerOpts: Record<string, unknown> = {};
  if (engine.diarize) providerOpts.diarize = true;
  if (keyterms.length) providerOpts.keyterm = keyterms.slice(0, 100);

  const rungs = [
    { profile: "verbose_json+provider", body: { ...base, response_format: "verbose_json", provider: { options: providerOpts } } },
    { profile: "verbose_json", body: { ...base, response_format: "verbose_json" } },
    { profile: "json", body: base },
  ];
  const ladder = Object.keys(providerOpts).length ? rungs : rungs.slice(1);

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

/** Text → readable lines. The chat path already returns one turn per line; a bare ASR transcript is
 *  one wall of text, so break it on sentence ends and pair them up. */
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
  op: "card";
  /** Cluster name, not an id — see deriveActions for why this matters. */
  topic?: string;
  /** Label of another card this one relates to. Resolved server-side; unresolvable ones are dropped
   *  rather than guessed at. */
  relatesTo?: string;
  relation?: string;
  kind?: string;
  label?: string;
  detail?: string;
  state?: string;
  tags?: string[];
  emoji?: string;
  toRef?: string;
  edge?: string;
  /** VERBATIM line this came from. The server rejects the action if this text isn't in the
   *  transcript — which makes fabricating a decision a validation failure rather than a matter of
   *  the model choosing to behave. */
  source?: string;
};

const SYSTEM = `You watch a live conversation transcript and maintain a visual canvas of it.

You do NOT write to the canvas directly. You return operations and the server applies them.

OPERATIONS
  {"op":"card","topic":"Scope","kind":"...","label":"...","detail":"...","source":"...",
   "relatesTo":"<label of another card>","relation":"blocks|depends|answers|contradicts"}

"topic" is the SHORT NAME of the cluster this card belongs to.

TOPICS MUST BE BROAD. A whole conversation should end up with roughly 3 to 6 of them, not one per
fact. "OpenAI", not "OpenAI Lumen" and "OpenAI Sore" and "OpenAI Models" as three separate things —
those are one subject seen three times. Before inventing a name, check KNOWN TOPICS and reuse
anything that could plausibly hold this card. A new name is a last resort.

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

CARD KINDS — pick the closest; when nothing else fits, use "note"
  note         a substantive statement: a fact, a number, a claim, an argument someone made
  decision     something settled
  action       something someone will do
  question     something asked and not yet answered
  requirement  something needed or asked for
  risk         something that could go wrong
  milestone    a date or checkpoint
  quote        a striking line worth showing verbatim
  aside        small talk or a tangent — kept in case it matters later

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
        required: ["op", "topic", "kind", "label", "detail", "state", "source", "relatesTo", "relation"],
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
  opts: { cfg?: CanvasMode["derive"]; spend?: Spend } = {},
): Promise<RawAction[]> {
  // STATELESS per chunk. Previously each call needed the board as it stood after the previous chunk,
  // which forced derivation to run strictly in sequence — measured at 10-30s each, so 24 minutes of
  // audio meant ~6 minutes of derivation no matter how fast any single call got. Naming topics as
  // strings removes that dependency entirely and lets every chunk be judged at once.
  const user =
    (knownTopics.length ? `KNOWN TOPICS — reuse these names when they fit\n${knownTopics.join(", ")}\n\n` : "") +
    (knownCards.length ? `KNOWN CARDS — you may point relatesTo at any of these\n${knownCards.slice(-25).join("\n")}\n\n` : "") +
    (glossary.length ? `KNOWN NAMES — use these spellings\n${glossary.join(", ")}\n\n` : "") +
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
        900,
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
  opts: { cfg?: CanvasMode["derive"]; spend?: Spend } = {},
): Promise<{ from: string; to: string; kind: string }[]> {
  if (cards.length < 3) return [];

  const list = cards.map((c) => `${c.id} [${c.kind}] ${c.label}`).join("\n");
  const out = await chat(
    [
      {
        role: "system",
        content: `You find real relationships between items on a board. Reply ONLY with JSON:
{"links":[{"from":"<id>","to":"<id>","kind":"answers|blocks|depends|contradicts"}]}

  answers      the first resolves a question posed by the second
  blocks       the first stops the second from happening
  depends      the first only holds if the second does
  contradicts  they cannot both be true, or they are two sides of an argument

Use ONLY ids from the list. Return 2 to 6 links — the strongest ones, not every plausible pair. If
two items are merely about the same subject, that is NOT a relationship; they are already grouped.
Return {"links":[]} only if the items genuinely have nothing to do with each other.`,
      },
      { role: "user", content: `BOARD\n${list}` },
    ],
    600,
    240_000,
    { model: opts.cfg?.model, spend: opts.spend },
  );

  try {
    const first = out.indexOf("{");
    const last = out.lastIndexOf("}");
    if (first < 0 || last <= first) return [];
    const parsed = JSON.parse(out.slice(first, last + 1));
    const ids = new Set(cards.map((c) => c.id));
    const ok = new Set(["answers", "blocks", "depends", "contradicts"]);
    return (parsed.links ?? [])
      .filter((l: { from: string; to: string; kind: string }) =>
        ids.has(l.from) && ids.has(l.to) && l.from !== l.to && ok.has(l.kind))
      .slice(0, 8);
  } catch {
    return [];
  }
}
