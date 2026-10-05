"use client";

import { useSyncExternalStore } from "react";

// A media query as React state, for the few decisions that are genuinely about the DEVICE rather than
// the box — which is what lib/density.ts measures and what nearly everything should use. The test is
// "would this be wrong on a 900px pane on a desktop?": grid view on a phone is wrong because the phone
// can never give four panes room, not because one pane happens to be narrow; a 380px pane on a laptop
// can be widened by dragging the divider, a phone cannot.
//
// useSyncExternalStore, not useState+effect: the value is read during render, so a pane that mounts on
// a phone never renders one frame of the desktop layout and then swaps.
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    // Server render: assume desktop. Every client-side branch below falls back to the existing
    // desktop behaviour, so a hydration pass on a phone only ever narrows, never invents.
    () => false,
  );
}

/** Below Tailwind's `md` — the breakpoint the shell already uses to drop the bento beside the chat. */
export const PHONE_QUERY = "(max-width: 767px)";
export const usePhone = () => useMediaQuery(PHONE_QUERY);
