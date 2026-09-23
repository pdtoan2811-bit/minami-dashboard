// Background polls should stop when nobody can see them.
//
// Measured 2026-09-23 on an idle board: 26 API calls every 20 seconds, `/api/agent/live` alone every
// 1.5s — and none of it paused for a hidden tab, so a dashboard left open in the background kept the
// server parsing and the browser re-rendering all day for no reader. Every poll on the home page gates
// its TICK on `pageHidden()` (never its first load — a tab opened in the background must still have a
// board to show) and re-runs on `onPageVisible` so returning to the tab shows fresh data at once rather
// than up to one interval stale.
//
// SSE streams are deliberately NOT paused: they are pushed, cost nothing while quiet, and pausing one
// would drop the events that make a pane's state correct when you come back. See §5e.

export const pageHidden = (): boolean => typeof document !== "undefined" && document.hidden;

/** Call `fn` whenever the tab becomes visible again. Returns the unsubscribe. */
export function onPageVisible(fn: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const h = () => { if (!document.hidden) fn(); };
  document.addEventListener("visibilitychange", h);
  return () => document.removeEventListener("visibilitychange", h);
}
