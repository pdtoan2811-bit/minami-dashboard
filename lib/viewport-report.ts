"use client";
// Each device reports, once per page load, the sizes the browser actually gives it (§23). The cover
// screen's redirect was tuned against spec-sheet numbers and never fired on the real Flip; this is so
// the next tuning reads `~/.minami/viewports.jsonl` instead of guessing.
export function reportViewport(page: string) {
  try {
    const body = {
      page, w: innerWidth, h: innerHeight, sw: screen.width, sh: screen.height, dpr: devicePixelRatio,
      coarse: matchMedia("(pointer: coarse)").matches, standalone: matchMedia("(display-mode: standalone)").matches,
      ua: navigator.userAgent.slice(0, 160),
    };
    navigator.sendBeacon?.("/api/viewport", new Blob([JSON.stringify(body)], { type: "application/json" }));
  } catch { /* diagnostics only */ }
}
