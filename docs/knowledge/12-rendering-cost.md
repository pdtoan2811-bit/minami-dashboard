# Rendering cost — why the machine got hot

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 12. Rendering cost — why the dashboard made the machine hot

This app is open all day. Anything it does *per frame*, it does forever.

> 🐛 **The dashboard burned ~31% of a CPU core while sitting completely idle.** Reported as "lag and
> heat". It was not the polling, the parser or the SDK: `next-server` measured **1.5%**, and the
> browser's *renderer* process stayed ~6% throughout. The cost was entirely in the **GPU process** —
> compositing. Measured on an isolated headless tab (headless does no display compositing at all, so a
> real window is worse and drags `WindowServer` with it):
>
> | State | GPU process |
> |---|---|
> | All animations disabled | **0.0%** |
> | As shipped (before) | **31.1%** |
> | After removing two `backdrop-blur`s | **14.0%** |
> | …and `spin3d` also off | 6.6% |
>
> **The mechanism: `backdrop-filter` × any animated descendant.** A `backdrop-filter` element must
> re-blur everything beneath it whenever anything inside its box changes. Every live indicator — the
> pulse dot, the think-dots, the activity shimmer, the spinning icon — was a descendant of a blurred
> surface. A **1.5-pixel dot** pulsing at 60fps therefore re-blurred an entire 610×348 tile, and the
> think-dots re-blurred the **768×800** chat panel, sixty times a second, forever. Isolated: the same
> eight animations cost **30.6%** with the blur and **4.6%** without — a **6.6× multiplier**.
>
> **And it bought nothing.** `backdrop-filter` blurs what is *behind* an element. Behind these was a
> flat `body` colour and one very smooth radial gradient — and blurring a low-frequency image returns
> essentially the same image. The panel is a flex *sibling* of the grid, never over it. Verified with
> `elementsFromPoint`, and by screenshot.

### Rules that follow
- **Never animate inside a `backdrop-filter` subtree.** Not "prefer not to" — it converts a
  few-pixel animation into a full-surface re-blur every frame. If a surface needs blur, it must not
  contain anything that moves; if it contains something that moves, it must not be blurred.
- **Never put a CSS `filter` on an animating element.** A filter on an animating node can't be
  compositor-cached. Moving `drop-shadow` off the rotating icon onto its static wrapper cut `spin3d`
  from 45.2% to 18.6% for the same seven icons. The shadow no longer tracks the rotation — invisible
  at this size, and not worth a permanent tax. This applies to *transitions* too, not just loops: the
  icons' hover scale used to sit on the shadowed wrapper, re-rasterising the filter for the whole
  320ms. The transform now lives on an inner node the filter doesn't wrap (§5e).
- **Pause an animation rather than adding and removing it.** `animation-play-state: paused` is free —
  a paused animation schedules no frames, so the idle floor is the same as having no animation at all
  — and it is the only way to start and stop a loop *without a snap*, because a CSS animation always
  restarts at 0%. The rule that comes with it: the element's static `transform` must equal the
  0%/100% keyframe, or the very first hover jumps.
- **`prefers-reduced-motion` is honoured**, which is both the accessibility answer and a real off
  switch — idle GPU goes to 0.0%. One-shot entrance animations are made instant rather than removed,
  so elements that animate *in* don't get stranded at `opacity: 0`.

### The cost of animation is a FIXED per-frame tax, not a per-element one

The second audit measured the shape of the cost directly, on the shipped build, by varying only the
number of animated elements on one page:

| Animated elements | GPU | Renderer | Total |
|---|---|---|---|
| **0** | 0.6% | 0.7% | **1.3%** |
| 1 | 8.8% | 3.8% | **12.6%** |
| 4 | 9.2% | 4.1% | **13.3%** |
| 41 | 10.1% | 7.0% | **17.1%** |

**0 → 1 costs 11.3 points. 1 → 41 costs 4.5 more.** You are paying for the existence of a 60fps frame
loop, not for what is in it. Three consequences, all counter-intuitive enough to be worth stating:

- **Optimising an individual animation is close to worthless.** `will-change` was measured twice and
  did nothing — on `spin3d` (33.8% → 33.2%) and on the pulse dots (9.2% → 8.8%). Both inside noise.
- **Reducing the NUMBER of animated elements is close to worthless.** One dot costs what four do.
- **The only move that pays is going to zero.** Anything that animates permanently costs the same as
  everything animating permanently.

> 🐛 **One "review" badge held the whole tab at ~12.6% CPU forever.** The tile's status dot pulsed when
> `p.active` (touched in the last 2 minutes) *or* `p.review` — and `review` is a standing state that
> persists for days. So on a board with any project awaiting review, the page never reached zero
> animations, and never dropped to the 1.3% floor. `spin3d` had the same bug via `active={p.active}`,
> tumbling for two minutes after a turn ended. Both now key off `la` / `busy` — a turn actually in
> flight, a signal the code already computed one line below. **A pulse should mean "this is happening
> now"; a standing state gets a static dot.**

### Also measured, and NOT the problem
Ruled out by experiment, so nobody re-investigates them:
- **Server cost per pane is negligible.** `next-server` went 2.48% → 3.17% for four extra panes —
  **0.17% per pane** — while absorbing ~190 requests/min per tab. The incremental parser and its
  caches are doing their job; polling frequency is not worth tuning.
- **React re-rendering from polls is ~2 points.** Silencing *every* poll endpoint moved the renderer
  only 14.5% → 12.6%. The renderer's idle cost is animation frame work, not reconciliation.

### Measured and rejected
**Layer promotion (`will-change: transform` + `backface-visibility: hidden`) on the icons does
nothing here** — 33.8% → 33.2% for a fixed 12-icon workload, inside noise. The residual `spin3d` cost
is per-frame compositing of the 3D layers themselves, not re-rasterisation, so promotion only adds
memory. Recorded because it is the obvious next thing to try, and it doesn't work.

### How to measure this again
`ps -o time=` deltas over a fixed interval, **not** `%CPU` — macOS `%CPU` is a decaying average and
bleeds previous state into the next sample. Drive one isolated headless tab, then A/B by injecting
CSS at runtime into the *same* page and process; the live data changes the animation count between
page loads, so comparing two loads is not a controlled experiment.

---
