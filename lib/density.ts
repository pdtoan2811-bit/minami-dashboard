"use client";

// How much room does this box actually have — and therefore how much chrome may it spend?
//
// The dashboard's hard case is four chat panes in one panel. Measured on a 1455px-wide window with the
// bento railed, each pane is ~689 x 354 CSS px, and the chrome came to ~200px of that: header 46,
// flow strip 42, mode row 34, composer 50, padding 24. The transcript — the only part anyone opened the
// pane to read — got 146px. Chrome was 60% of the pane.
//
// Media queries can't see that, because none of it is about the WINDOW: the same 27" display shows a
// roomy pane at one pane and a cramped one at four, and dragging the panel divider changes it again
// without any breakpoint firing. Container queries get closer but only in CSS, and half of what has to
// give way here is a decision about *what to render at all* (a whole control row folding into one pill,
// a side panel that must not open), not about styling something that is rendered anyway.
//
// So: measure the box, name the result, and let every component inside it read the same name. One
// vocabulary — roomy / snug / tight / micro — instead of a breakpoint per component that drifts.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export type Density = "micro" | "tight" | "snug" | "roomy";

// Ordered small → large, so a tier is comparable with a number.
const ORDER: Density[] = ["micro", "tight", "snug", "roomy"];
export const rank = (d: Density) => ORDER.indexOf(d);
/** `atLeast(d, "snug")` — "is there at least this much room". The house test for a conditional. */
export const atLeast = (d: Density, min: Density) => rank(d) >= rank(min);
/** One tier roomier. Used for "Embody": the surface you're actually touching may spend more. */
export const looser = (d: Density): Density => ORDER[Math.min(ORDER.length - 1, rank(d) + 1)];

// Floors per tier, largest first. BOTH axes must clear a tier to earn it, and the tightest binding
// axis wins — a pane can be 900px wide and still only have room for two lines of transcript, which is
// exactly the four-pane case. Height is the axis that actually hurts here; width mostly decides
// whether a control row can stay on one line.
const STEPS: { tier: Density; w: number; h: number }[] = [
  { tier: "roomy", w: 720, h: 620 },
  { tier: "snug", w: 520, h: 460 },
  { tier: "tight", w: 380, h: 330 },
];

// Growing back costs an extra 28px. Without it a box parked on a threshold flip-flops: showing a
// control row makes the transcript shorter, which can push the box back under the line that revealed
// it, which hides it again — a layout oscillation that reads as flicker and never settles. Same
// one-way-hysteresis discipline as the bento divider's COLLAPSE_AT / EXPAND_AT in app/page.tsx.
const HYST = 28;

/** Pure, so the thresholds can be reasoned about (and tested) without a DOM. */
export function tierFor(w: number, h: number, prev?: Density): Density {
  for (const s of STEPS) {
    // Only an UPGRADE pays the hysteresis margin; dropping to a smaller tier is immediate, because
    // overflowing chrome is a visible bug and half a second of it is worse than an eager reflow.
    const pad = prev && rank(s.tier) > rank(prev) ? HYST : 0;
    if (w >= s.w + pad && h >= s.h + pad) return s.tier;
  }
  return "micro";
}

// useLayoutEffect is a no-op (and warns) during Next's server prerender.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Measure an element and name its tier. Seeds synchronously before paint, so a pane that is born
 *  cramped never flashes its full chrome and then swallows it. */
export function useDensity(ref: RefObject<HTMLElement | null>): Density {
  const [tier, setTier] = useState<Density>("roomy");
  // The observer callback must compare against the CURRENT tier without re-subscribing on every
  // change — the ref is what makes the hysteresis above stateful across resize events.
  const tierRef = useRef<Density>("roomy");

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number, h: number) => {
      // A hidden box (display:none — see the focused-pane grid in app/page.tsx) measures 0x0. Treating
      // that as "micro" would demote every collapsed pane and then re-promote it on reveal, which is a
      // pointless double reflow of a subtree nobody is looking at.
      if (w <= 0 && h <= 0) return;
      const next = tierFor(w, h, tierRef.current);
      if (next === tierRef.current) return;
      tierRef.current = next;
      setTier(next);
    };
    const r = el.getBoundingClientRect();
    apply(r.width, r.height);
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const box = e.borderBoxSize?.[0];
      apply(box ? box.inlineSize : e.contentRect.width, box ? box.blockSize : e.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return tier;
}

/** So anything nested — the composer, the browser/file panels — sees the same number the pane it
 *  lives in measured, instead of guessing from its own width or taking a prop through three levels. */
export const DensityContext = createContext<Density>("roomy");
export const useDensityTier = () => useContext(DensityContext);
