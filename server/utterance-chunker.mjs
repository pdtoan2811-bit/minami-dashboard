// UTTERANCE CHUNKER — turns per-participant PCM into units worth judging.
//
// ── Why not just cut every 15 seconds ────────────────────────────────────────────────────────────
// The file pipeline slices on a clock because a recording has no idea who is talking. Recall gives us
// something better: a SEPARATE stream per participant, each labelled with a real name. That changes
// what a chunk should be.
//
// A clock cut lands mid-sentence roughly every time, which is why the file path carries 6s of overlap
// and pays to transcribe those seconds twice. A speaker's own silence is a free, correct boundary —
// people stop talking at the ends of thoughts. So we cut on the pause, not on the clock, and the
// overlap disappears along with the duplicated cost.
//
// ── The trap this creates, and the floor that stops it ───────────────────────────────────────────
// Cutting on pauses makes the CALL COUNT a property of the conversation rather than of a setting. A
// four-person meeting with rapid back-and-forth produces far more utterances than 240/hour, and every
// one of them costs a judge call. That is the same failure the A/B already paid for once — chunk size
// multiplies every leg that runs per chunk — except here nobody would see it coming from a config
// value, because there isn't one.
//
// MIN_SPEECH_MS is the floor: a speaker's audio accumulates until they have said a few seconds of
// ACTUAL SPEECH, and only then does a pause end the chunk. A run of three-word interjections becomes
// one call rather than six. Silence never counts toward it, so a slow talker is not penalised and a
// quiet participant costs nothing at all.
//
// ── Detecting speech is the part that actually decides whether any of this works ─────────────────
// All of the above depends on knowing which frames are speech, and getting that wrong does not
// present as "the VAD is wrong" — it presents as chunks never closing on pauses, AND as the STT
// returning empty transcripts, AND as a sparse board. Three unrelated-looking symptoms, one number.
// See SPEECH_OVER_PEAK for what that cost and why the threshold is now relative to the speaker.
//
// ── Everything is measured in bytes, not seconds ────────────────────────────────────────────────
// Recall delivers exactly 16 kHz mono S16LE, so one millisecond is exactly 32 bytes. Durations are
// therefore arithmetic on buffer lengths rather than wall-clock timers, which means the chunker
// behaves identically whether audio arrives in real time or is replayed at full speed in a test.

/** 16000 samples/s × 2 bytes. One ms of audio, exactly. */
export const BYTES_PER_MS = 32;

/** A pause this long ends an utterance — about the gap at the end of a sentence. Shorter and it
 *  fires inside the natural hesitations of Vietnamese and English alike. */
const SILENCE_MS = 700;

/** Speech required before a pause is allowed to close a chunk. The cost floor — see above.
 *
 *  ⚠️ MEASURED, and the first value was wrong. Set to 10s on the reasoning that ten seconds of talk
 *  is a fair unit of work. On the first real Google Meet (2026-08-12) that made the pause path
 *  UNREACHABLE: 10 chunks out of 10 closed at the ceiling and none on a pause, because real
 *  conversation runs 13–45% speech — fifteen seconds of wall audio carried 0.5–6.7s of talking. Ten
 *  seconds of speech would have meant 22–75s of wall time per chunk, far past the liveness target,
 *  so every chunk hit MAX_CHUNK_MS and cut on a clock instead. The design degraded silently into the
 *  thing it was built to replace, and nothing errored to say so.
 *
 *  3.5s is a real utterance, still collapses a run of interjections into one call, and is reachable
 *  inside a 15s window at the density actually observed. Speech density is a property of the meeting,
 *  not of the config — so this floor has to be small enough for the sparsest plausible conversation. */
const MIN_SPEECH_MS = 3_500;

/** Hard ceiling on how long a speaker can talk before we cut anyway.
 *
 *  This is the WORST CASE on time-to-card, and it is worth understanding what it adds up to. The
 *  full chain a listener experiences is:
 *
 *      up to MAX_CHUNK_MS waiting for the cut  +  ~2-7s transcribe  +  ~2-4s judge
 *
 *  At 15s that is up to ~26 seconds between saying something and seeing it, which reads as broken on
 *  a live surface however correct it is. Most chunks close earlier on a real pause — measured 6-9s in
 *  a real meeting — so this only bites the person who is monologuing, which is exactly the person
 *  most likely to be presenting to the board.
 *
 *  10s trades a little cost (more judge calls per hour) for ~5 seconds off the worst case. Cost is no
 *  longer the binding constraint here; perceived latency is. */
const MAX_CHUNK_MS = Number(process.env.CANVAS_MAX_CHUNK_MS || 10_000);

/** Absolute floor below which a frame is silence no matter what. Deliberately very low — it exists
 *  only to stop a digitally-silent stream from calibrating itself into hearing noise.
 *
 *  ⚠️ A FIXED THRESHOLD DOES NOT WORK, and 320 was badly wrong. Measured on a real Meet 2026-08-12:
 *  while anh was talking continuously, 15-second windows registered only 0.4–2.7s as speech. That one
 *  number caused every symptom we saw — chunks never reached the speech floor so they all hit the
 *  15s ceiling, and a chunk that is 96% "silence" makes the STT endpoint return an empty transcript,
 *  which is exactly the 502s in the log. Two failures that looked unrelated, one cause.
 *
 *  Gain is a property of the speaker's microphone, their distance from it, and whatever Meet's noise
 *  suppression did on the way — none of which we can know in advance. So the threshold is derived
 *  from the stream instead of asserted about it. */
const ABSOLUTE_FLOOR = 60;

/** Speech is anything above this fraction of the participant's recent PEAK loudness.
 *
 *  Relative to the peak, not to the noise floor — and the difference is not academic. Calibrating on
 *  the floor has a bootstrap failure: a packet containing nothing but speech makes the quietest frame
 *  in it a speech frame, the floor calibrates to speech level, and then nothing is loud enough to
 *  count. That is not a hypothetical; it is what the first version of this fix did, and the
 *  regression test below caught it before it reached a meeting.
 *
 *  A peak cannot fail that way. Continuous speech gives peak = speech, so every frame clears 12% of
 *  it. Silence gives frames near zero, which clear nothing. Both a shouted and a murmured speaker are
 *  measured against themselves. */
const SPEECH_OVER_PEAK = 0.08;

/** How fast the peak forgets, per 20ms frame.
 *
 *  0.9985 gave a HALF-LIFE OF NINE SECONDS, which is far too long: one loud moment — a laugh, a
 *  chair, a plosive on the mic — set the peak high and then the 8% threshold excluded ordinary speech
 *  for the next ten seconds. That is a large part of why 15-second windows measured under 3 seconds
 *  of speech while somebody was talking the whole time.
 *
 *  0.993 is a ~2s half-life: long enough to ride out the gap between sentences, short enough that the
 *  reference is what this speaker sounds like NOW rather than the loudest thing they have ever done. */
const PEAK_DECAY = 0.993;

/** RMS of a 16-bit LE frame. Operating on the raw buffer rather than converting to floats — this runs
 *  on every packet of every speaker for the whole meeting on a 2-vCPU box. */
function rms(buf, from, to) {
  let sum = 0;
  const n = (to - from) >> 1;
  if (n <= 0) return 0;
  for (let i = from; i + 1 < to; i += 2) {
    const s = buf.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Minimal RIFF/WAVE header. Recall's PCM is already the exact shape the STT endpoint wants, so
 *  wrapping it costs 44 bytes and removes ffmpeg from the live path entirely — no subprocess per
 *  chunk, which on a CAX11 running the bot and the pipeline together is the difference between a
 *  spawn storm and arithmetic. */
export function wav(pcm, sampleRate = 16000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);        // PCM chunk size
  h.writeUInt16LE(1, 20);         // format = PCM
  h.writeUInt16LE(1, 22);         // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); // byte rate
  h.writeUInt16LE(2, 32);         // block align
  h.writeUInt16LE(16, 34);        // bits per sample
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Keep the speech, drop the gaps.
 *
 *  ⚠️ THIS IS THE FIX FOR THE EMPTY TRANSCRIPTS, and the reason the earlier threshold work kept
 *  missing. Measured on a real meeting 2026-08-12: 339 seconds of audio arrived across 414 seconds of
 *  meeting, so Recall streams a participant's channel near-continuously — silence included. A 15s
 *  window holding 2s of talking genuinely IS 87% silence, and the STT endpoint was right to return
 *  nothing for it. 12 of 23 utterances failed that way.
 *
 *  Three separate tunings of the detector could never have fixed that, because the problem was not
 *  which frames we called speech — it was that we posted the silence anyway.
 *
 *  Trimming is also strictly cheaper and faster: a 3-second clip of actual speech costs a fraction of
 *  a 15-second window and comes back sooner. PAD_MS keeps a little air either side of each run so
 *  word onsets and trailing consonants are not clipped, which is what makes a trimmed clip sound
 *  natural to an ASR model rather than chopped.
 *
 *  Deliberately forgiving: a frame only has to clear the threshold ONCE in a window for the whole
 *  window to be kept. Over-keeping costs a few cents; over-trimming loses what somebody said. */
const PAD_MS = 220;

function trimSilence(pcm, threshold) {
  const frame = 20 * BYTES_PER_MS;
  const pad = Math.ceil((PAD_MS * BYTES_PER_MS) / frame);
  const total = Math.ceil(pcm.length / frame);

  const loud = new Array(total).fill(false);
  for (let f = 0; f < total; f++) {
    const from = f * frame;
    if (rms(pcm, from, Math.min(from + frame, pcm.length)) >= threshold) loud[f] = true;
  }

  const keep = new Array(total).fill(false);
  for (let f = 0; f < total; f++) {
    if (!loud[f]) continue;
    for (let k = Math.max(0, f - pad); k <= Math.min(total - 1, f + pad); k++) keep[k] = true;
  }

  // Stitch the kept runs together. Contiguous runs are copied whole rather than frame by frame, so a
  // mostly-speech chunk costs one copy instead of hundreds.
  const out = [];
  let runStart = -1;
  for (let f = 0; f <= total; f++) {
    if (f < total && keep[f]) { if (runStart < 0) runStart = f; continue; }
    if (runStart >= 0) {
      out.push(pcm.subarray(runStart * frame, Math.min(f * frame, pcm.length)));
      runStart = -1;
    }
  }
  return out.length ? Buffer.concat(out) : Buffer.alloc(0);
}

/**
 * One chunker for the whole meeting; it keeps a separate accumulator per participant.
 *
 * @param onChunk called with { speaker, email, pcm, speechMs, totalMs, reason }
 */
export function createChunker(onChunk) {
  /** participant key → accumulator */
  const acc = new Map();

  const get = (p) => {
    const key = String(p?.id ?? p?.name ?? "unknown");
    let a = acc.get(key);
    if (!a) {
      // `peak` is this participant's own recent loudness, decayed slowly. Every speaker is measured
      // against themselves, so a close-mic'd shouter and a laptop-mic murmurer both work without
      // anyone tuning a number per meeting.
      a = { speaker: p?.name ?? null, email: p?.email ?? null, parts: [], bytes: 0, speechMs: 0, silenceMs: 0, peak: 0 };
      acc.set(key, a);
    }
    // A participant can be nameless on their first packets and named a moment later; take the name
    // the instant it appears rather than freezing the null.
    if (!a.speaker && p?.name) a.speaker = p.name;
    if (!a.email && p?.email) a.email = p.email;
    return a;
  };

  const flush = (a, reason) => {
    if (!a.parts.length) return;
    const raw = Buffer.concat(a.parts);
    a.parts = [];
    const bytes = a.bytes;
    const speechMs = a.speechMs;
    a.bytes = 0;
    a.speechMs = 0;
    a.silenceMs = 0;
    // A chunk that is entirely room tone has nothing to transcribe and would cost a call to discover
    // that. The floor already prevents this in the pause path; this covers the MAX_CHUNK path.
    if (speechMs < 400) return;

    const pcm = trimSilence(raw, Math.max(ABSOLUTE_FLOOR, (a.peak ?? 0) * SPEECH_OVER_PEAK));
    if (pcm.length < 400 * BYTES_PER_MS) return; // nothing survived trimming

    onChunk({
      speaker: a.speaker,
      email: a.email,
      pcm,
      speechMs,
      totalMs: pcm.length / BYTES_PER_MS,
      rawMs: bytes / BYTES_PER_MS,
      reason,
    });
  };

  return {
    /** Feed one Recall audio frame. */
    push(participant, pcm) {
      if (!pcm?.length) return;
      const a = get(participant);

      // Classify in 20ms frames. Coarser and a short word is swallowed by the silence around it;
      // finer and the RMS is too noisy to be a reliable boundary.
      const frame = 20 * BYTES_PER_MS;

      // Two passes over the packet: measure, then classify. Classifying as we measure would judge the
      // first frames of a packet against a peak that has not seen them yet, which makes the result
      // depend on packet boundaries — an artefact of the network, not of the speech.
      for (let i = 0; i < pcm.length; i += frame) {
        const r = rms(pcm, i, Math.min(i + frame, pcm.length));
        a.peak = Math.max(r, (a.peak ?? 0) * PEAK_DECAY);
      }
      const threshold = Math.max(ABSOLUTE_FLOOR, (a.peak ?? 0) * SPEECH_OVER_PEAK);

      let speech = 0;
      let trailingSilence = 0;
      for (let i = 0; i < pcm.length; i += frame) {
        const end = Math.min(i + frame, pcm.length);
        const ms = (end - i) / BYTES_PER_MS;
        if (rms(pcm, i, end) >= threshold) {
          speech += ms;
          trailingSilence = 0;
        } else {
          trailingSilence += ms;
        }
      }

      a.parts.push(pcm);
      a.bytes += pcm.length;
      a.speechMs += speech;
      // Only silence at the END of the packet can close a chunk; a gap in the middle is a pause the
      // speaker already talked through.
      a.silenceMs = speech > 0 ? trailingSilence : a.silenceMs + trailingSilence;

      if (a.bytes / BYTES_PER_MS >= MAX_CHUNK_MS) return flush(a, "max");
      if (a.silenceMs >= SILENCE_MS && a.speechMs >= MIN_SPEECH_MS) return flush(a, "pause");
    },

    /** Meeting over — nothing is left half-said. */
    end() {
      for (const a of acc.values()) flush(a, "end");
      acc.clear();
    },

    /** For the receiver's status line. */
    speakers: () => [...acc.values()].map((a) => a.speaker).filter(Boolean),
  };
}
