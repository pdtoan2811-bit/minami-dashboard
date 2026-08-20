"use client";
// CUT SCENE — the board stops, and one moment gets the whole screen.
//
// ── Why a reaction deserves this and a card doesn't ──────────────────────────────────────────────
// Everything else on this canvas is a RECORD: a card, an edge, a chip. Records accumulate, and their
// job is to still be legible in ten minutes. A reaction is not a record — it is a MOMENT, and a
// moment rendered as a 12px pill in a card footer has been filed rather than felt. On a shared
// screen it is invisible: nobody in the room notices that the AI just agreed something was the
// strongest claim of the meeting.
//
// So the reaction gets the screen. Not because it is more important than the board, but because it
// is the only thing here with a MOMENT shape, and a moment that nobody notices did not happen.
//
// ── The pill stays ──────────────────────────────────────────────────────────────────────────────
// The cut scene does not replace the chip on the card. Cut scene = the moment, chip = the memory.
// Someone scrolling back at minute forty must still find it, and a full-screen flash is the one
// thing on this board that leaves nothing behind.
//
// ── Slow, not flashy ────────────────────────────────────────────────────────────────────────────
// The temptation is a confetti burst. Confetti is loud AND fast, which reads as a notification —
// something demanding dismissal. This is the opposite gesture: the board dims, one glyph rises and
// settles, a line of text says what it was for, and it recedes. ~3.4s end to end, most of it hold.
// Elegance here is entirely a function of nothing happening quickly.
//
// ── One at a time, and not too many ─────────────────────────────────────────────────────────────
// The relate pass returns 3–5 reactions in a single frame. Playing them back to back would take the
// screen away for fifteen seconds — the board would be unusable exactly when it just got interesting.
// The queue plays one at a time, drops anything beyond MAX_QUEUED, and enforces a cooldown so a busy
// stretch of meeting cannot turn into a slideshow. A cut scene that happens constantly is a screen
// saver, and stops meaning anything.

import { useCallback, useEffect, useRef, useState } from "react";

/** Total time on screen, matched to the keyframes in globals.css. */
const DURATION = 3400;
/** Reduced-motion hold. Shorter because none of the 3.4s is arrival or exit any more — it is all
 *  hold, and a still image needs only long enough to be read. */
const STILL_DURATION = 2200;
/** Minimum quiet between two cut scenes. Long enough that two in a row read as two events. */
const COOLDOWN = 2600;
/** Anything past this in one burst is filed to the cards and never shown big. */
const MAX_QUEUED = 2;

export type Moment = {
  id: string;
  emoji: string;
  label?: string;
  /** The card's own detail line — WHY this moment happened, in the speakers' own words.
   *
   *  ⚠️ Without it the scene announces that Minami reacted and never says to what. "WORTH MARKING"
   *  over a gif tells a room the machine had a feeling; it does not tell them which thing they just
   *  said earned it, which is the entire value of marking a moment in front of the people who made
   *  it. The label is the claim, this is the substance. */
  detail?: string;
};

/** Which folder under public/memes/ each glyph draws from. The names are anh's, chosen while
 *  collecting — this map is the only place the two vocabularies meet. */
const FOLDER: Record<string, string> = {
  "🤝": "agreement", "💯": "full-agreement", "✅": "settled", "💡": "new-idea",
  "🔥": "strongest-claim", "😮": "that-landed", "👏": "worth-marking", "❓": "left-hanging",
  "🎉": "milestone", "🙌": "everyone-aligned", "✨": "worth-keeping",
};

/** A meme needs far more time on screen than a glyph does.
 *
 *  An emoji is read instantly — it is one shape and you already know it. A meme has to be SEEN, then
 *  recognised, then found funny, and a gif also has a loop to get through. 5s was measured against a
 *  real collection and still cut them off mid-beat. 7.5s is roughly two loops of a short reaction gif
 *  and long enough for the joke to land before the board comes back. */
const MEME_DURATION = 7500;

type MemeIndex = Record<string, string[]>;

/** Everything played in THIS call, so a folder is exhausted before anything repeats.
 *
 *  ⚠️ Keyed by URL, and duplicates across folders are therefore NOT deduped by this alone — the same
 *  Drake gif copied into agreement/ and settled/ has two URLs. That is deliberate for now: comparing
 *  file CONTENT would need hashing every file, and anh explicitly chose "just copy the file". The
 *  practical effect is small (two of eleven folders would have to fire in one call), and the fix if
 *  it ever bites is a hash in the API route, not here. */
const played = new Set<string>();

/** Pick a meme for a moment, or null to fall back to the emoji scene.
 *
 *  Random, because the folder IS the taxonomy: if an image is in agreement/ it fits any agreement,
 *  so choosing between them is a matter of variety rather than accuracy. No model call, no latency,
 *  on a path that must never stall a live meeting. */
export function pickMeme(emoji: string, index: MemeIndex | null): string | null {
  const folder = FOLDER[emoji];
  if (!folder || !index) return null;
  const all = index[folder];
  if (!all?.length) return null;
  const fresh = all.filter((u) => !played.has(u));
  // Exhausted rather than empty: once every meme in the folder has played, start the folder again
  // rather than silently dropping to the emoji scene for the rest of the call.
  const pool = fresh.length ? fresh : all;
  if (!fresh.length) for (const u of all) played.delete(u);
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  played.add(chosen);
  return chosen;
}

/** What each glyph is FOR. The emoji alone is ambiguous at 140px — 🔥 could be "this is great" or
 *  "this is on fire, badly" — so the scene always names the reason underneath it. */
export const MOMENT_MEANING: Record<string, string> = {
  "🔥": "Strongest claim yet",
  "😮": "That landed",
  "💡": "New idea",
  "❓": "Left hanging",
  "👏": "Worth marking",
  "🤝": "Agreement",
  "🙌": "Everyone's aligned",
  "✨": "Worth keeping",
  "💯": "Full agreement",
  "🎉": "Milestone",
  "✅": "Settled",
};

export function CutScene({ moment, onDone, meme }: { moment: Moment | null; onDone: () => void; meme?: string | null }) {
  // REDUCED MOTION IS NOT A SHORTER CUT SCENE — it is a still one.
  //
  // The global rule in globals.css clamps every animation to 1ms, which is right for a slide-in and
  // catastrophic here: these keyframes END at opacity 0, so the scene snapped straight to its exit
  // state and the viewer got a dimmed screen with nothing on it for three and a half seconds. Caught
  // in a headless browser, which defaults to `reduce` — the same thing every reduced-motion user
  // would have had.
  //
  // So: no animation, no dim, a shorter hold, and the content rendered plainly. The moment is still
  // delivered; only the movement is dropped, which is exactly what the preference asks for.
  const [still, setStill] = useState(false);
  useEffect(() => {
    setStill(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  }, []);

  useEffect(() => {
    if (!moment) return;
    // A meme holds longer than a glyph — see MEME_DURATION. Reduced motion still shortens it: the
    // preference is about movement, and a looping gif is movement.
    const t = setTimeout(onDone, still ? STILL_DURATION : meme ? MEME_DURATION : DURATION);
    return () => clearTimeout(t);
  }, [moment, onDone, still, meme]);

  if (!moment) return null;
  const meaning = MOMENT_MEANING[moment.emoji] ?? "Reaction";
  /** ⚠️ THE KEYFRAMES MUST RUN FOR EXACTLY AS LONG AS THE SCENE IS HELD.
   *
   *  These animations END AT OPACITY 0 — the exit is the tail of the keyframe, not a separate step.
   *  So hardcoding DURATION here while holding a meme for MEME_DURATION meant the animation finished
   *  at 3.4s and the remaining 1.6s was a dimmed board with an invisible meme on it. Caught in a
   *  screenshot: a ghosted gif behind fully-legible cards, which reads as a rendering fault rather
   *  than a moment.
   *
   *  One number drives both, so the two can never disagree again. */
  const hold = meme ? MEME_DURATION : DURATION;
  const anim = (name: string) => (still ? undefined : `${name} ${hold}ms cubic-bezier(0.22, 1, 0.36, 1) both`);

  return (
    <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center" aria-live="polite">
      {/* The wash. Blur rather than a flat scrim: the board stays visible as SHAPE, so the cut scene
          reads as the room dimming around what is already there, not as a modal covering it up. */}
      <div
        className={still ? "absolute inset-0" : "absolute inset-0 backdrop-blur-[3px]"}
        style={{
          background: "radial-gradient(ellipse at center, rgba(244,244,242,0.86) 0%, rgba(244,244,242,0.62) 100%)",
          animation: anim("cutWash"),
        }}
      />

      <div className="relative flex flex-col items-center">
        {/* One ring, travelling outward and fading. A single slow ring reads as resonance; three
            staggered ones read as a notification badge, which is the register we are avoiding. */}
        {still ? null : (
          <span
            className="absolute size-[150px] rounded-full border border-neutral-300/70"
            style={{ animation: anim("cutRing") }}
            aria-hidden
          />
        )}
        {meme ? (
          /* ⚠️ THE LABEL STAYS UNDERNEATH. A meme alone is a reaction with no stated cause — funny to
             whoever gets the reference, opaque to the client in the room who is watching their own
             meeting. The image carries the feeling; the line below still says what the moment WAS.
             Capped rather than full-bleed for the same reason the glyph is: the board must stay
             visible as shape around it, so the scene reads as the room dimming rather than a modal. */
          /* ⚠️ THE EMOJI STAYS. It is the one part of the scene that says WHAT KIND of moment this is
             without anyone having to read: a meme is a feeling, the glyph is the category. Dropping
             it for the image meant a room saw a reaction and had to work out what Minami thought had
             happened. Rendered as a badge on the corner so it reads instantly at screen-share size
             without covering the joke. */
          <span className="relative inline-block" style={{ animation: anim("cutGlyph") }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- animated gif; next/image would kill the animation */}
            <img
              src={meme}
              alt=""
              className="max-h-[52vh] max-w-[62vw] rounded-2xl object-contain"
              style={{ boxShadow: "0 26px 60px -20px rgba(16,24,40,0.42)" }}
            />
            <span
              className="absolute -bottom-5 -left-5 grid size-[92px] place-items-center rounded-full bg-white text-[50px] leading-none"
              style={{ boxShadow: "0 12px 30px -8px rgba(16,24,40,0.34)" }}
              aria-hidden
            >
              {moment.emoji}
            </span>
          </span>
        ) : (
          <span
            className="text-[132px] leading-none"
            style={{ animation: anim("cutGlyph"), filter: "drop-shadow(0 18px 34px rgba(16,24,40,0.16))" }}
          >
            {moment.emoji}
          </span>
        )}

        <div className="mt-7 flex flex-col items-center gap-2" style={{ animation: anim("cutText") }}>
          <span className="text-[13px] font-bold uppercase tracking-[0.18em] text-neutral-400">
            {meaning}
          </span>
          {moment.label ? (
            <span className="max-w-[min(680px,72vw)] text-center text-[26px] font-semibold leading-snug tracking-[-0.01em] text-neutral-800">
              {moment.label}
            </span>
          ) : null}
          {/* Quieter and smaller than the label on purpose: a cut scene is read at a glance from
              across a video call, so the hierarchy has to survive being skimmed. The label is what
              was decided; this is what was said about it. Clamped to two lines — past that it stops
              being a caption and starts being a card, which the board already renders. */}
          {moment.detail ? (
            <span
              className="max-w-[min(620px,68vw)] text-center text-[16px] leading-snug text-neutral-500"
              style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
            >
              {moment.detail}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The queue. Feed it moments as they arrive; it plays at most one at a time, with a cooldown.
 *
 *  `seen` is keyed by moment id and never cleared, so a graph frame that re-sends a reaction the
 *  board already has — which every frame does, since the graph is sent whole — cannot replay it. That
 *  is the difference between a cut scene and a strobe. */
export function useCutScenes() {
  const [current, setCurrent] = useState<Moment | null>(null);
  const queue = useRef<Moment[]>([]);
  const shown = useRef(new Set<string>());
  const lastEnded = useRef(0);
  /** Bumped whenever the queue gains something, purely to re-run the advance effect below. The queue
   *  itself is a ref — it must survive a remount — and a ref changing cannot wake an effect. */
  const [nudge, setNudge] = useState(0);

  const offer = useCallback((moments: Moment[]) => {
    let added = false;
    for (const m of moments) {
      if (shown.current.has(m.id) || queue.current.some((q) => q.id === m.id)) continue;
      if (queue.current.length < MAX_QUEUED) {
        queue.current.push(m);
        added = true;
      } else {
        // Overflow is RETIRED, not deferred. The graph is re-sent whole on every frame, so a moment
        // merely skipped comes back on the next render and plays later — turning one six-reaction
        // burst into six minutes of scenes at the cooldown cadence, which is the slideshow this cap
        // exists to prevent. Marking it shown is what makes the drop actually a drop; the chip on the
        // card still carries it, only the big moment is forfeited.
        shown.current.add(m.id);
      }
    }
    if (added) setNudge((n) => n + 1);
  }, []);

  // ADVANCE. One effect owns the whole schedule: when nothing is playing and something is waiting,
  // start it once the cooldown has elapsed.
  //
  // This is deliberately an effect with real dependencies rather than a pump() called from wherever.
  // The pump version worked and then silently stopped working, because React's dev double-invoke runs
  // mount effects, discards them, and runs them again — so a timer armed in the first pass was
  // cleared by the cleanup and re-armed only if some later render happened to call pump again.
  // Nothing errored; scenes just never appeared. Expressed as an effect, the cleanup and the re-arm
  // are the same mechanism, so the double-invoke is a no-op instead of a coin flip.
  useEffect(() => {
    if (current || !queue.current.length) return;
    const wait = Math.max(0, COOLDOWN - (Date.now() - lastEnded.current));
    const t = setTimeout(() => {
      const next = queue.current.shift();
      if (!next) return;
      // Marked SHOWN here, not when offered — "already displayed" is the only predicate that is true
      // at most once regardless of how many times the graph re-offers the same reaction.
      shown.current.add(next.id);
      setCurrent(next);
    }, wait);
    return () => clearTimeout(t);
  }, [current, nudge]);

  const done = useCallback(() => {
    lastEnded.current = Date.now();
    setCurrent(null);
  }, []);

  return { current, offer, done };
}
