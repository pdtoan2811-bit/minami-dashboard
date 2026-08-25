"use client";
import { PRESENCE_LABEL, type Lang } from "@/lib/canvas-lang";
// Minami's presence: what she is doing right now.
//
// Without this the canvas is ambiguous in the worst way — a pause while the model thinks looks
// exactly like a pause because nothing was said, which looks exactly like the thing being broken.
// On a shared screen that ambiguity is expensive: the customer cannot tell whether to keep talking.
//
// Three states, deliberately: listening (audio arriving), thinking (a judgement in flight), idle.
// The distinction that matters is listening vs thinking — "I heard you" and "I'm working on it" are
// different promises, and collapsing them into one spinner tells you neither.
//
// SIZED FOR A SHARED SCREEN. The first version was a 12.5px label with 3.5px bars, which is correct
// at desk distance and gone entirely once the stream is re-encoded — the one element on the canvas
// whose whole job is to be noticed from the corner of your eye, rendered too small to notice. It is
// now roughly double, with a live halo behind it, because peripheral vision responds to movement and
// area, not to detail.
export function Presence({
  state,
  lang = "en",
}: {
  state: "listening" | "thinking" | "idle";
  /** ⚠️ THE LONGEST-LIVED STRING ON THE BOARD. A cut scene holds the screen for three seconds; this
   *  badge is there for the whole call — which makes it the most conspicuous thing to leave in
   *  English on a Vietnamese meeting. Defaults to English so an unwired caller is unchanged. */
  lang?: Lang;
}) {
  /** ── A STATUS LIGHT, NOT A BUTTON ──────────────────────────────────────────────────────────
   *  This was briefly clickable, and anh could not find it — "I see no button". Correct: a badge
   *  whose entire visual job is to look passive cannot also advertise an action. The controls moved
   *  to CommandDock, and this went back to doing one thing.
   *
   *  ── Why the old look read as dated ───────────────────────────────────────────────────────
   *  Three things, all of them 2015 habits: a heavy two-layer drop shadow, a saturated 1.5px ring
   *  in the state colour, and BOLD text in that same colour. Together they make a badge that shouts
   *  — three separate signals all saying "green" at once, on a surface that is otherwise quiet.
   *
   *  Now: one hairline border, a soft single shadow, and the colour carried ONLY by the small mark
   *  on the left. The label is neutral grey at medium weight, because the word "Listening" is not
   *  the information — the fact that something is animating is. Frosted rather than solid white so
   *  it sits ON the canvas instead of on top of it. */
  const cfg = {
    listening: { label: PRESENCE_LABEL[lang].listening, color: "#0f9d6e" },
    thinking: { label: PRESENCE_LABEL[lang].thinking, color: "#2a6fd6" },
    idle: { label: PRESENCE_LABEL[lang].idle, color: "#9ca3af" },
  }[state];

  const live = state !== "idle";

  return (
    <div className="canvas-presence pointer-events-none absolute bottom-9 left-9">
      <div
        className="relative flex items-center gap-2.5 rounded-full border border-neutral-200/70 bg-white/80 px-4 py-2 backdrop-blur-xl"
        style={{ boxShadow: "0 6px 22px -12px rgba(16,24,40,0.30)" }}
      >
        {state === "listening" ? <Bars color={cfg.color} /> : null}
        {state === "thinking" ? <Orbit color={cfg.color} /> : null}
        {state === "idle" ? <span className="size-2 rounded-full" style={{ background: cfg.color }} /> : null}
        <span
          className="text-[14px] font-medium tracking-[-0.01em]"
          style={{ color: live ? "#374151" : "#9ca3af" }}
        >
          {cfg.label}
        </span>
      </div>
    </div>
  );
}

/** Listening reads as SOUND — bars responding to a voice. Anything circular here would say
 *  "processing", which is the other state.
 *
 *  Each bar runs at its own DURATION, not merely its own delay. Shared timing produces a travelling
 *  wave — pretty, obviously synthetic, and read as a loading animation. Mutually prime-ish periods
 *  never resettle into a pattern, which is what a real level meter looks like: uncorrelated.
 *
 *  Periods are ~2.7x their first values (620ms → 1.7s and so on). The ratios between them are kept
 *  exactly, because the ratios are what stop the bars resynchronising; only the tempo changed. At the
 *  old speed the whole cluster twitched, and twitching in the corner of a shared screen costs the
 *  presenter the room's attention every second and a half. The eased timing function does the rest —
 *  a bar should arrive at its peak and leave it, never snap. */
function Bars({ color }: { color: string }) {
  const bars = [
    { dur: 1700, delay: 0 },
    { dur: 2400, delay: 240 },
    { dur: 1350, delay: 110 },
    { dur: 2800, delay: 400 },
    { dur: 1900, delay: 160 },
  ];
  return (
    <span className="flex h-6 items-end gap-[4px]">
      {bars.map((b, i) => (
        <span
          key={i}
          className="w-[5px] rounded-full"
          style={{
            background: color,
            height: "100%",
            // A sinusoidal ease rather than ease-in-out: it has no flat top, so the bar is always
            // moving and never appears to have stalled at its peak.
            animation: `vu ${b.dur}ms cubic-bezier(0.37, 0, 0.63, 1) ${b.delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

/** Thinking reads as WORK — a dot going round. Continuous rather than pulsing, because a pulse
 *  suggests something arriving and nothing has arrived yet.
 *
 *  2.4s per revolution, not 0.9s. A fast spinner is a progress bar's cousin and carries its promise:
 *  something is nearly done. Thinking here can run for twenty seconds, so a spinner that looks
 *  impatient is actively lying. Slow rotation reads as deliberation, which is the truth.
 *
 *  Linear, deliberately — an eased rotation stutters at the ends of each cycle and reads as broken. */
function Orbit({ color }: { color: string }) {
  return (
    <span className="relative block size-5">
      <span className="absolute inset-0 rounded-full border-[3px] border-neutral-200" />
      <span
        className="absolute inset-0 rounded-full border-[3px] border-transparent"
        style={{ borderTopColor: color, animation: "spin 2.4s linear infinite" }}
      />
    </span>
  );
}
