# Meeting canvas — audio → transcript → ReactFlow board

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 17. The live canvas pipeline

`/canvas` turns speech into a board: audio is sliced, transcribed, judged into cards, and streamed to
a ReactFlow graph over SSE. It is the surface behind Minami's "join the call" work.

| Piece | File |
|---|---|
| Slicing | `lib/audio.ts` — ffmpeg, 60s chunks, 6s overlap, mono 16 kHz 32 kbps |
| Model calls | `lib/mimo.ts` — `transcribe()` and `deriveActions()`, both via OpenRouter |
| Ingest + SSE | `app/api/canvas/live/route.ts` — two bounded pools, decoupled emit |
| Board | `lib/canvas-graph.ts`, `components/canvas/GraphCanvas.tsx`, `TranscriptPanel.tsx` |

### Mechanics that are already right

Three of these were bought with measurements and should not be undone casually:

- **Decoupled emit.** Transcript goes out the moment it exists; cards follow when judged. Bundled into
  one event, nothing appeared for 41s and the canvas read as dead.
- **Stateless-per-chunk derivation.** The model names a topic as a *string*, never an id. Ref-based ids
  forced each chunk to wait for the previous chunk's board, serialising 10–30s calls into minutes.
- **Bounded parallelism, separate pools.** Removing the cap pushed time-to-first-transcript from 8s to
  29s and failed two chunks in three. Transcription gets its own budget because starving it is what
  makes the surface look dead.
- **Grounding by word-overlap.** A card whose `source` quote isn't ~65% present in the transcript is
  dropped, so fabricating a decision is a validation failure rather than a matter of good behaviour.

### The root defect: a chat LLM was doing ASR's job

`transcribe()` sends base64 audio to `/chat/completions` on `xiaomi/mimo-v2.5` and asks for a verbatim
transcript. That one choice is upstream of all three complaints about this surface:

- **Latency** — ~13s per audio-minute, and roughly **one chunk in three returns `content: null`**
  because the model spent the turn reasoning. The 3× retry loop in `transcribe()` exists only to paper
  over that, putting p90 near 26–39s per chunk.
- **Accuracy** — the same invented product name came back as Luna, Lumen and Luno across three runs of
  identical audio. `glossaryFrom()` is a regex patch applied *downstream* of a defect introduced
  *upstream*.
- **Cost** — retries burn input tokens that produce nothing.

Speaker labels are worth calling out separately: the transcribe prompt asks for "a short speaker label
and a colon", and mimo obliges. **Those labels are invented.** There is no diarization anywhere in this
pipeline, so any speaker attribution on the board today is decoration.

> 🐛 **A blank reply is not an answer.** The empty-`content` failure was invisible for three rounds of
> speed work: the chunk silently produced no transcript, so no cards, and the canvas just waited for
> the next chunk. It presented as "the whole thing is slow" rather than "one call came back empty",
> and `reasoning: { exclude: true }` hid the evidence. Same shape as every other incident in this
> record — a 200 OK that looks authoritative and is only a claim.

### OpenRouter now has dedicated STT, and this pipeline predates it

Researched 2026-08-10. OpenRouter shipped `POST /api/v1/audio/transcriptions` after `a076719` wired
this pipeline up, so the LLM path was the only option when it was written and no longer is.

Same key, same base URL. Parameters: `model`, `input_audio: { data, format }` (base64 bytes, **not** a
data URI), `language` (ISO-639-1, auto-detected if omitted), `temperature`, `response_format`
(`json` | `verbose_json`), `timestamp_granularities` (`["segment"]` | `["word"]`), and a `provider`
passthrough for provider-specific options. Response is `{ text, usage }` where `usage` carries
`seconds` and `cost` — real per-request cost, no token arithmetic.

Catalogue and price, from `GET /api/v1/models?output_modalities=transcription`:

| Model | Cost | Per 1h call | Multilingual | Diarization |
|---|---|---|---|---|
| `nvidia/parakeet-tdt-0.6b-v3` | $0.0015/min | $0.09 | European only | no |
| `openai/whisper-large-v3` | $0.0015/min | $0.09 | 99 languages | no |
| `x-ai/grok-stt-1.0` | $0.10/hr | $0.10 | 25+, switches mid-stream | **yes** |
| `qwen/qwen3-asr-flash-2026-02-10` | $0.000035/s | $0.13 | 11 languages | no |
| `deepgram/nova-3` | $0.0043/min | $0.26 | see gotcha below | yes |
| `microsoft/mai-transcribe-1.5` | $0.36/hr | $0.36 | 43 languages | no |

For scale: `deriveActions()` on mimo is ~$0.015 per audio-hour. **The judging leg is not where the
money is** — leave its model alone and optimise it for latency, not price.

### Gotchas found in the research, before anyone builds on this

- **The endpoint is batch-only.** No WebSocket, no streaming, 60s upstream compute timeout, base64 JSON
  or ≤25 MB multipart, no audio URLs, no SRT/VTT. A live call therefore has to be rolling fixed
  windows, and liveness bottoms out at *chunk length + ~1s*. That is the ceiling on "join the call",
  and it is a property of OpenRouter, not of the models.
- **Word timestamps are provider-conditional.** `timestamp_granularities` works on OpenAI-compatible
  providers (OpenAI, Groq, Together) and **returns 400 elsewhere** — including Deepgram and Parakeet.
  So "cheapest" and "has timecodes" are not the same shortlist.
- **Nova-3's code-switching mode does not cover Vietnamese.** `language=multi` spans exactly ten
  languages — English, Spanish, French, German, Hindi, Italian, Japanese, Dutch, Russian, Portuguese.
  Vietnamese is supported by Nova-3 only as a *monolingual* selection. For a VI/EN meeting you must
  pick one language per session, or pick a different model.
> 🐛 **Diarization does NOT survive OpenRouter. Measured, not guessed.** Probed `x-ai/grok-stt-1.0`
> directly on 2026-08-10 with a 15s slice, sending the same audio three ways: with
> `provider.options.{diarize, keyterm}`, with plain `verbose_json`, and with nothing. The first two
> returned **byte-identical** bodies — no `speaker` field on any segment, and the keyterm list changed
> nothing either. The provider block is accepted and then ignored, which is the worst failure shape
> available: a 200, plausible output, and a silently dropped capability. `verbose_json` itself works
> fine and returns `segments` plus word-level `words` with timestamps.
>
> So **the provider passthrough is not a route to provider-native features.** If speaker attribution
> is required, OpenRouter is the wrong layer and the call has to go to xAI's own `/v1/stt` (which also
> has a WebSocket streaming API at $0.20/hr, lifting the batch-only ceiling above) or to Deepgram
> direct. Everything on this page about diarization-through-OpenRouter is now closed: it doesn't work.
>
> Second surprise from the same probe: the 15s clip came back as **one segment spanning the whole
> clip**, not utterance-split. `linesFromSTT` therefore only takes the segment path when a speaker
> field is actually present, and otherwise sentence-splits the flat text — without that check the
> entire chunk renders as one unbroken line.

### The A/B harness — SHIPPED, and what it measured

Built 2026-08-10. `/api/canvas/live?mode=mimo|stt|stt-fast` runs the same audio down three pipelines
(`lib/canvas-modes.ts`), each changing exactly ONE thing from the arm before it, and ends with a
`report` SSE event the operator panel keeps per arm so two runs can be read side by side.

Constraints taken from anh: **mixed language varying per meeting, real diarization required, cheap.**
That eliminated most of the catalogue and left `x-ai/grok-stt-1.0` — which then failed the diarization
requirement anyway, for the reason in the callout above.

60s of the test mp3, one sample per arm, run AFTER the max_tokens fix below:

| | A · mimo (control) | B · real ASR |
|---|---|---|
| chunking | 1 × 60s | 4 × 15s |
| **1st transcript** | 11.5s | **1.3s** |
| **1st card** | 40.0s | **18.9s** |
| wall clock | **54.9s** | 164.6s |
| × realtime | **1.1×** | 0.4× |
| **$ / audio-hour** | **$0.030** | $1.432 |
|   ↳ ASR leg | $0.011 | $0.110 |
|   ↳ judging leg | $0.019 | $1.321 |
| transcribe / judge calls | 1 / 1 | 4 / 4 |
| wasted calls | 0 | 1 |
| transcript lines | 2 | 6 |
| topics · cards · edges | 3 · 4 · 2 | 6 · 13 · 11 |

**Read this table carefully, because the two halves disagree.** Arm B wins every *responsiveness*
number — first transcript is 9× faster, first card 2× faster — and extracts three times the content
from the same minute. Arm A wins wall clock and costs **48× less**.

The ASR leg behaved exactly as researched: $0.11/audio-hour against $0.10 published, and the direct
probe transcribed 15s of audio in 0.98s (~15× realtime). Nothing about the STT endpoint disappointed.
**Everything expensive in arm B is the judging leg** — $1.32 of its $1.43. Two compounding causes: 15s
chunks mean 4× as many judge calls per minute, and each of arm B's judge calls cost ~19× arm A's
($0.004 vs $0.0002). The 4× is by construction; the 19× is not explained. Leading suspect is
`provider: { sort: "latency" }`, which may be routing mimo to a pricier endpoint — **untested**, and
the cheapest next experiment is arm B with `latencyRouting: false`.

The generalisable lesson stands even though the numbers moved: **a per-call price is not a per-hour
price.** Chunk size multiplies every leg that runs per chunk, so a latency fix that shrinks the unit
of work silently multiplies everything downstream of it.

> 🐛 **The first A/B run measured a bug, not the arms — and its conclusion was backwards.**
> Before the max_tokens fix, the same two arms reported: arm A producing **nothing at all** (three
> blank transcription replies, 0 cards, 175s, $0.74/audio-hour) and arm B at $1.04. That reads as
> "the control is broken, ship the challenger". After the fix, arm A costs $0.030/audio-hour and works
> — **25× cheaper than its own broken self**, because it stopped paying for three failed calls — and
> the cost gap between the arms *widened* in the opposite direction to the first reading.
>
> The harness was correct throughout; it faithfully measured a pipeline whose budgets were below its
> model's reasoning cost. **A benchmark run against a broken build is worse than no benchmark**, since
> it produces a confident number with a plausible story attached. Both arms were re-run before any of
> these figures were written down, and the pre-fix numbers are kept here only as the warning.

Open questions this created:

1. **Why do arm B's judge calls cost 19× arm A's?** Test `latencyRouting: false` first.
2. **Chunk size is a knob with two opposed costs** — 15s minimises latency, and multiplies judging
   spend by 4. Nothing has swept the middle. 30s is the obvious next point.
3. **Judging is the entire remaining bottleneck**: 18.9s to first card against 1.3s to first
   transcript. Arm C exists to test that and has still never been run.
4. **Is arm B's 13 cards vs arm A's 4 better, or just more?** Nobody has read the two boards
   side by side. More chunks mean more judge calls mean more cards; that is not the same as hearing
   more.

### What each arm actually changes

| | A `mimo` | B `stt` | C `stt-fast` |
|---|---|---|---|
| transcriber | chat LLM | `/audio/transcriptions` | same as B |
| chunk / overlap | 60s / 6s | 15s / 2s | same as B |
| concurrency | 3 | 6 | 6 |
| judge model | mimo | mimo | `google/gemini-3-flash-preview` |
| strict JSON schema | no | yes | yes |
| latency routing | no | yes | yes |

Judging stays on mimo in both A and B deliberately — it was believed to be cost-noise, and keeping it
fixed is what let the run above attribute the cost blow-out to chunk size rather than to a model swap.
Everything downstream of the transcript (grounding rule, label dedupe, fuzzy topic merge) is identical
in all three, so a difference in the board is a difference in what was *heard*.

Two implementation notes worth keeping:

- **Strict schema requires every property in `required`.** Optionality is expressed as
  `type: ["string","null"]`, not by omitting the key. Getting it wrong is a 400 at request time.
- **Cost comes from OpenRouter, not from arithmetic.** `usage.cost` is on every response (the old
  `usage: {include: true}` flag is deprecated and inert), and calls are billed per leg — a failed
  request is deliberately not counted, since OpenRouter doesn't charge for it.

### The board follows the room's language — including the strings WE write

The judge has always been told to write in the language people are speaking ("Vietnamese in,
Vietnamese out"), and the reason it is given is load-bearing: *the board is screen-shared back to the
people who are talking, so a card they cannot read is worse than no card.*

**We never applied that rule to ourselves.** Every string the app wrote was hardcoded English, sitting
directly on top of Vietnamese content:

```
MILESTONE                     ← ours, English, 10px tracked caps
Meme cut scene chạy được rồi  ← theirs, Vietnamese
```

Two places: `MOMENT_MEANING` in `CutScene.tsx` (the cut-scene caption — the one moment that takes the
whole screen in front of a client) and the `Presence` badge, which is on screen for the *entire call*
and so is the more conspicuous of the two.

`lib/canvas-lang.ts` now holds the per-language tables plus the detection. Three decisions worth
keeping:

- **Detected, not configured.** `sttLang` exists, but it configures the *ear*, not the room: it is
  often unset, and it is one value for a call that code-switches. The board is better evidence — it is
  what the judge wrote, in the language it decided each point was made in.
- **Two independent signals, both with a floor.** Diacritic ratio alone flips an English board to
  Vietnamese on a single "Hà Nội"; Vietnamese function words alone miss a bare line like "Deploy vào
  thứ sáu". Either may say yes; neither may on one hit.
- **Topics are excluded, and an empty board means "no evidence", not "English".** Topics are short
  noun phrases and often bare English product names, so a board judged on its headings reads English
  while every card under it is Vietnamese. With no cards at all `CutScene` falls back to reading the
  moment itself — which is what keeps `?memes=preview` honest, since its sample cards are Vietnamese
  but never join the graph.

⚠️ **The Chrome overlay carries a copy of these tables and a port of the detector.** It lives in
another repo (`~/Minami/extension`) and reads `GET /api/canvas?stream=1` to mirror reactions onto
whatever tab is being demoed; no endpoint serves the caption text, so it cannot receive them. A glyph missing from a table still renders with the
generic caption, so adding one to the judge's `emoji` enum degrades rather than breaks — but the two
still have to move together.

### Not measured / not researched

Arm C has never been run. Chunk size has never been swept. Both arms above are a **single sample** on
60 seconds of one English podcast — enough to kill a hypothesis, not enough to rank two arms on
accuracy, and it says nothing about the Vietnamese/mixed-language case that drove the model choice in
the first place.

Transcript quality was not scored against ground truth, because there isn't any: the accuracy numbers
on the scorecard are proxies (empty chunks, topic fragmentation, drop rate). Judging whether arm B
*hears better* still needs someone to read the transcript.

How Minami actually gets call audio in the first place. The pipeline reads a hardcoded mp3
(`CANVAS_AUDIO_FILE`), and the bot-joins-the-meeting leg — Meet/Zoom admission, audio capture, consent
— is untouched by any of the above.

---
