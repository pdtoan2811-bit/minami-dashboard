"use client";

import { useSyncExternalStore } from "react";

// Is this page on a cover screen — the Galaxy Z Flip 7's Flex Window (~360×400 CSS px)? The main page
// redirects to /glance when it is (§23), because the full board at that size is a pane you can't read.
//
// Two conditions, both required:
//  - the VIEWPORT is ≤ 420×480. That is the reactive half: folding or unfolding the phone resizes the
//    viewport, the media query fires, and the hook re-renders.
//  - the physical SCREEN is that small too. The viewport alone also matches things that are not a
//    cover screen: a laptop window dragged narrow and short, or a phone's main screen with the soft
//    keyboard up (this app sets interactive-widget=resizes-content, so the keyboard shrinks the
//    viewport). Redirecting a user mid-typing to /glance would throw away the screen they were on.
//    `screen` is the display's own size and doesn't move with the keyboard or the window.
export const COVER_QUERY = "(max-width: 420px) and (max-height: 480px)";
const COVER_MAX_SHORT = 420;
const COVER_MAX_LONG = 480;

function snapshot(): boolean {
  if (!window.matchMedia(COVER_QUERY).matches) return false;
  const { width, height } = window.screen;
  return Math.min(width, height) <= COVER_MAX_SHORT && Math.max(width, height) <= COVER_MAX_LONG;
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
