"use client";

import { useSyncExternalStore } from "react";

// Is this page on a cover screen — the Galaxy Z Flip 7's Flex Window? The main page redirects to
// /glance when it is (§23), because the full board at that size is a pane you can't read.
//
// What a cover screen IS, as the browser sees it: a TOUCH display whose viewport is close to SQUARE and
// SHORT. That is the whole test.
//
// It used to also require `window.screen` to be ≤420×480, to rule out a phone's main screen with the
// keyboard up (interactive-widget=resizes-content shrinks the viewport). On the real Flip 7 the cover
// never redirected (2026-10-06, "look nothing like you pitched") — inside Good Lock's launcher `screen`
// (or the density) doesn't report the 360×400 the spec sheet implies, so the second condition never
// held and the cover got the ordinary phone layout. The shape test rules the keyboard case out on its
// own: the Flip main screen with a keyboard up is still a ~412×560+ portrait strip (ratio ≥1.35), not a
// square, and a laptop window is excluded by `pointer: coarse`.
// `lib/viewport-report` logs what each device actually reports, so the numbers can be checked, not guessed.
export const COVER_QUERY =
  "(pointer: coarse) and (max-width: 560px) and (max-height: 600px) and (min-aspect-ratio: 4/5) and (max-aspect-ratio: 5/4)";

// The decision only changes when the viewport WIDTH changes — folding, unfolding, moving to the cover,
// rotating. A soft keyboard changes only the height, and on the Flip's main screen (and the N5 folded)
// it squeezed the viewport near-square and short enough to pass COVER_QUERY: the page jumped to
// /glance mid-answer, losing the typed text and the question you were on (audit 2026-10-08 — very
// likely the "tapped Other, it flashed" report). `screen` can't settle it (see above), width can.
let latched: { cover: boolean; w: number } | null = null;
function snapshot(): boolean {
  const w = window.innerWidth;
  if (latched && latched.w === w) return latched.cover;
  latched = { cover: window.matchMedia(COVER_QUERY).matches, w };
  return latched.cover;
}

export function useCoverScreen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(COVER_QUERY);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    snapshot,
    // Server render: not a cover screen. The redirect is a client decision; the worst case is one
    // frame of the board before the hook flips and the caller navigates.
    () => false,
  );
}
