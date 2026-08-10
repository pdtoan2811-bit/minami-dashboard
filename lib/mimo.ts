// OpenRouter / mimo client for the meeting canvas.
//
// Two jobs, deliberately two calls: audio → transcript, then transcript → canvas actions. Doing it
// in one call is cheaper and hears tone, but you never see WHAT it heard — so a wrong card becomes
// unexplainable. The transcript is the artifact that makes every downstream mistake debuggable.
//
// Measured on this model 2026-08-09: ~13s per 60s of audio, 1,050,000 token context,
// $0.14/M in · $0.28/M out. Reasoning is excluded — it was the entire source of latency variance
// (2.0s / 7.4s / 2.7s on identical input, tracking reasoning length, not network).

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
async function chat(messages: Msg[], maxTokens: number, timeoutMs = 240_000): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await chatOnce(messages, maxTokens, timeoutMs);
    if (out.length > 10) return out;
  }
  return "";
}

async function chatOnce(messages: Msg[], maxTokens: number, timeoutMs: number): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: headers(),
      signal: ctl.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        // Turning this off is why the tail is predictable. Re-enable only with a measured reason.
        reasoning: { exclude: true },
        messages,
      }),
    });
    const raw = await res.text();
    // strict-off equivalent: the reasoning field can carry raw newlines that break strict parsers,
    // and we've already been bitten by that once.
    const data = JSON.parse(raw);
    if (data.error) throw new Error(`OpenRouter: ${JSON.stringify(data.error).slice(0, 300)}`);
    return (data.choices?.[0]?.message?.content ?? "").trim();
  } finally {
    clearTimeout(t);
  }
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
export async function transcribe(mp3: Buffer): Promise<string> {
  // No retry here — chat() already retries a blank reply. Two layers would multiply into nine calls
  // for one chunk and blow the time budget on the exact failure they exist to absorb.
  return chat(
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
  );
}

/* ── transcript → canvas actions ─────────────────────────────────────────────────────────────── */

export type RawAction = {
  op: "card";
  /** Cluster name, not an id — see deriveActions for why this matters. */
  topic?: string;
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
  {"op":"card","topic":"Scope","kind":"...","label":"...","detail":"...","source":"..."}

"topic" is the SHORT NAME of the cluster this card belongs to. Reuse a name from KNOWN TOPICS when
one fits; invent a new short name only for a genuinely new subject. The server creates clusters from
these names, so spelling a topic the same way twice is what keeps it one cluster instead of two.

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


export async function deriveActions(
  knownTopics: string[],
  lines: string,
  glossary: string[] = [],
): Promise<RawAction[]> {
  // STATELESS per chunk. Previously each call needed the board as it stood after the previous chunk,
  // which forced derivation to run strictly in sequence — measured at 10-30s each, so 24 minutes of
  // audio meant ~6 minutes of derivation no matter how fast any single call got. Naming topics as
  // strings removes that dependency entirely and lets every chunk be judged at once.
  const user =
    (knownTopics.length ? `KNOWN TOPICS — reuse these names when they fit\n${knownTopics.join(", ")}\n\n` : "") +
    (glossary.length ? `KNOWN NAMES — use these spellings\n${glossary.join(", ")}\n\n` : "") +
    `TRANSCRIPT\n${lines}`;

  const deadline = Date.now() + 45_000;
  let lastErr = "";
  for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt++) {
    try {
      const out = await chat(
        [{ role: "system", content: SYSTEM },
         { role: "user", content: attempt ? `${user}\n\nYour last reply was invalid (${lastErr}). Return ONLY the JSON object.` : user }],
        900,
        Math.max(8000, deadline - Date.now()),
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
