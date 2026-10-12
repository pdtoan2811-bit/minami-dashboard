# Meeting canvas — audio → transcript → ReactFlow board

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

> ⚠️ **Restored 2026-10-12.** Commit `d0d270a` (2026-09-29, "gemini-3.8-flash is the meeting ear")
> emptied this file — 257 deletions, no insertions — while its message describes a model change, not
> a rewrite. This is the 2026-08-25 text. What that commit actually changed (the ear is
> `gemini-3.8-flash`, reasoning "minimal", loop collapse, `scripts/ear-ab.mts`) is in its message and
> not yet folded in below.

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

---

## 17b. The phone as the ear — `/meet`

For a meeting in a room, there is no call for a Recall bot to join. `/meet` turns the phone into the
microphone and feeds the **same** pipeline the bot does:

```
phone /meet ── 0.5s frames, 16 kHz s16le ──► POST /api/meet/mic?id=phone-…
                                              lib/meet-mic.ts: createChunker (server/utterance-chunker.mjs)
                                              └─ per utterance ─► ingest POST, in-process ─► /api/canvas
phone ◄── SSE /api/canvas?stream=1&meeting=… (the board)
phone ◄── poll /api/meet/status every 1.5s (mic stats + trace tail)
```

It runs on the **dashboard** (:3000), not the meeting app (:3011), because the dashboard is the thing
already reachable from the phone over tailnet HTTPS. A secure origin is also what lets
`getUserMedia` work at all: over `http://<lan-ip>` the page says so instead of failing silently.

### Mechanics that are already right

- **Speech detection stays on the box.** The browser only resamples (box-filter decimation, not
  every-Nth-sample, which would alias a 48 kHz mic's hiss into the speech band) and ships. Cutting on
  pauses is the receiver's chunker, unchanged, so the phone and the bot cannot drift apart the way
  the two tunnel launchers did (§18).
- **Ingest is called in-process with a loopback URL** (`selfOrigin`). ingest's publish leg builds its
  `/api/canvas` URL from the request URL. Through `tailscale serve` that is the tailnet hostname, and
  a wrong port is worse: the board would be published to whichever server owns it, which on this box is
  the live dashboard. A loopback request reuses its own origin; anything else uses `PORT`.
- **Phone meetings are id-scoped**: `/api/meet/mic` refuses any id not shaped `phone-…`, so the open
  route can never write into a Recall meeting's session.
- **A 409 means the box lost the meeting** (restart/deploy). The phone re-opens under the same id and
  resends; the board restarts, but the words keep flowing rather than streaming into nothing.
- **The upload queue is bounded** (30 frames = 15s). Past that the oldest frames go and the strip
  counts `dropped`. A long dead spell would otherwise OOM the tab, and audio that late is no use to a
  live board.

### The strip: naming where it stopped

The rest of this pipeline cannot tell "nothing worth saying" from "I have stopped working". Both are a
200 and an empty board. So the top of `/meet` is a verdict line plus five stages, and the verdict
names the **first** red one:

| Stage | Green when | Red when |
|---|---|---|
| Mic | the local peak > 0.02 within 10s | track muted/ended, or **the page is hidden** (Android stops capture in the background) |
| Box | the server got a frame < 4s ago | no frame for 4s ("phone can't reach the Mac"), or no ingest token |
| Heard | a `hear` trace exists | ingest's last answer was ≥ 400 or threw |
| Judged | a `judge` trace exists | an `error` trace is newer than the last judge |
| Board | ≥ 1 real card (not warm-up) | never red: an empty board after speech is amber, and the 90s dead-man rule covers it |

Server ages are computed against the server's `now` and aged on the phone from the moment the poll
landed (`recvAt`). Phone and Mac clocks differ by seconds, enough to fake a red "Box".

Verified 2026-10-12 against a production build on :3033, with a headless Chromium at 412×915 and
`getUserMedia` stubbed to play 75s of real speech: all five green with 4 utterances, cards landing at
~10s intervals. Frame uploads were then cut, and within 8s the verdict read *Box: phone can't reach the
Mac*, with retries, queue and drop counts shown. After restoring, it was green again within 6s, and
ending archived the meeting (1.5 min, 6 utterances, 3 cards, $0.004). A curl-driven run of the same
clip: 150 frames → 8 utterances → 5 cards.

> 🐛 **The "ended" frame reached nobody.** Found while building this view: after End, the summary said
> 5 cards and the board, re-read from `/api/canvas?meeting=…`, showed 3, still marked live. ingest's
> end path built the final graph without `meetingId`, and `/api/canvas` files an untagged frame under
> the legacy `""` bucket. Every viewer pins itself to a meeting, so the publish that exists "to tell
> the screen it is over" never reached a pinned canvas, Recall's screen-share included. That canvas
> kept its last live frame and lost the cards judged in the drain. **Fix:** `graph.meetingId = id`
> before the archive. Verified: the meeting's bucket now reads `status: ended` with the summary's card
> count.

### No call at all: the room screen, recordings, keeping the audio

A meeting with no Meet still gets everything a Recall meeting gets: the board, the memes, and the archive.

- **The room screen is `/meet/screen`.** It is opened on the TV or laptop *before* Start, polls
  `/api/meet/status?latest=1` every 2s, and `location.replace`s itself onto
  `/canvas?present=1&meeting=<id>` when a phone meeting begins. It exists because the canvas needs the
  meeting id, and that id is minted on the phone at Start. Nobody should have to type
  `phone-20261012-1415-x7k2` into a TV. Present mode is the same tab-share mode the meet launcher uses:
  no operator panel, memes on. `/meet` also offers "Open the board here" and the copyable address, and
  on a desktop a checkbox opens the board in a second window at Start. That window is opened inside the
  tap and pointed at the board after the id exists, because a `window.open` after an `await` is no
  longer a user gesture and gets popup-blocked.
- **A laptop can be the mic.** The leaving-the-page rule (red Mic) applies only to touch devices
  (`pointer: coarse`). A desktop background tab keeps capturing, which the laptop-plus-board setup
  relies on.
- **Recordings: `POST /api/meet/recording`**, with the file as the body. The Mac decodes it with ffmpeg
  and feeds 0.5s frames through the same `pushFrame`, so downstream cannot tell a file from a mic. It is
  decoded on the Mac rather than in the browser because `decodeAudioData` on an hour of audio is a
  ~1 GB float buffer, which a phone tab will not survive. The feed is **paced** (1/2/4/8×, default 4×)
  on a deadline clock. Unpaced, an hour becomes ~360 utterances in a minute: ingest's
  `MAX_QUEUED_JUDGES` drops them as backlog, and nothing visibly builds on screen. A recording ends
  itself when the file runs out, so the phone can lock after the upload.
- **Keep the audio** (off by default, like `CANVAS_DUMP_DIR`, because it is real meeting audio). A live
  meeting's PCM is appended to `~/.minami/meet-audio/<id>.pcm` (`MEET_AUDIO_TMP`) per frame (an hour
  is ~115 MB, so not in RAM), then encoded to `recording.m4a` (AAC 32 kbps, ~14 MB/hour) in the
  archive folder. A recording keeps its original file instead (`recording.mp3` etc.), with no
  re-encode. The scratch copy is deleted either way.
- **`stats.summary` is written after the audio is saved**, because the phone reads it as "finished".
  `stats.ended` goes true earlier, before the archive exists, so the phone keeps polling until the
  summary arrives.

> 🐛 **"Meeting ended." with no outcome.** The first recording run ended on the phone with no Saved
> panel. The phone took `ended` as the signal and copied `summary` once, a few seconds before the Mac
> had written it. **Fix:** the phone keeps taking the summary while it is still missing.

Verified 2026-10-12 on a production preview (:3012):
- An 80s mp3 at 4× played through 8 utterances into 8 cards, ended itself, and saved
  `recording.mp3` in the archive.
- A 30s live stream with keep on gave a 30.0s `recording.m4a` at 36 kbps, and the scratch folder was
  empty afterwards.
- `/meet/screen` at 1280×720 jumped to the board within 2s of an upload and built it live.
- A 3-minute recording fired 4 cut scenes (new-idea ×2, that-landed, strongest-claim). The preview
  showed their emoji fallback only because `public/memes` is gitignored and missing from a worktree
  build; the live server serves the GIFs (200, image/gif).
- The phone recording flow (pick file → upload → progress → Saved + "Audio saved") ran end to end
  at 412×915.

### Not verified / not built

- **Not yet tried on the real Find N5 / Flip 7 mic.** The chunker's speech floor is calibrated against
  Recall's levels. A phone mic with AGC should sit in range, but that has not been measured. If Heard
  stays amber ("waiting for a pause") while you talk, levels are the first suspect.
- **The trace buffer is process-wide.** That is fine on :3000, where the phone is the only canvas
  traffic. If both ran in one process, the strip would show the other meeting's hear/judge lines.
- **No speaker names.** One mic hears the whole room, so utterances go in with `speaker: null`.
- **Launching a Recall bot from the phone is not built.** That is still `Minami Call.command` on the
  Mac (§18).
- **A recording's archive says "minutes" in wall-clock time.** ingest measures from the session's start,
  so 80s played at 4× books as 0.3 min. Cost and cards are right.
- **The board's language does not always follow the audio.** An English clip produced some Vietnamese
  cards and a Vietnamese "Đang nghe" pill. That is §17's language rule, not this leg.
- **The meetings page has no player for `recording.*`.** The file is in the folder.

