"use client";
import { useEffect, useRef } from "react";

// Android's Back (button or edge swipe) closes the topmost open layer — sheet, side slot, lightbox,
// flow, topic — instead of leaving the app (§23).
//
// The dashboard is one URL, so before this, history held nothing of ours and Back from anywhere —
// with the chat sheet up, inside a topic, in a lightbox — left the page (or closed the installed app).
// Each open layer now owns one history entry; Back pops it and the layer's own close runs.
//
// The hard half is a layer closed by the UI (✕, a tap outside, picking a chat). Its entry is still in
// history, and if it stayed there the next Back would land on a dead entry and seem to do nothing. So
// a layer closed any other way is marked dead, and `flush` rewinds over every dead entry at the top in
// one `history.go(-n)` — one, because a burst of closes (leaving a topic closes its sheet too) would
// otherwise race several async traversals against each other.
//
// No URL changes: the entries carry state only. Deep links are a different feature, and a URL that
// named a layer would have to be restorable on reload, which a live sheet or lightbox is not.

type Layer = { id: number; onBack: () => void; dead: boolean; path: string };

const stack: Layer[] = [];
let seq = 0;
// The layers a flush is rewinding over. Removed by identity when its popstate lands, not by count from
// the top — a layer opened in between (a pushState runs synchronously, the traversal does not) would
// otherwise be the one spliced off.
let rewinding: Layer[] | null = null;
let wired = false;
// When the user clicked a link to ANOTHER page. Leaving the board unmounts every open layer at once,
// and treating those as "closed by the UI" rewound history over their entries — `history.go(-n)` ran
// right after Next had pushed /dashboard, so clicking Metrics or Settings with a chat open flashed the
// new page and landed back on the board (2026-10-06). Layers torn down by a page change are simply
// dropped; their stale entries are stepped past by onPop's leftover branch if Back ever reaches them.
let leavingAt = 0;
const leaving = () => Date.now() - leavingAt < 3000;
function onClick(e: MouseEvent) {
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a || a.target === "_blank") return;
  const u = new URL(a.href, location.href);
  if (u.origin === location.origin && u.pathname !== location.pathname) leavingAt = Date.now();
}

function flush() {
  if (rewinding) return;
  // Belt and braces for a navigation that didn't come through a link click (router.push, a form):
  // a layer pushed on another path belongs to a page that is gone — drop it, never rewind over it.
  if (leaving() || stack.some((l) => l.dead && l.path !== location.pathname)) {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].dead) stack.splice(i, 1);
    return;
  }
  let n = 0;
  while (n < stack.length && stack[stack.length - 1 - n].dead) n++;
  if (!n) return;
  rewinding = stack.slice(-n);
  history.go(-n);
}

function onPop(e: PopStateEvent) {
  if (rewinding) {
    const gone = rewinding; rewinding = null;
    for (const l of gone) { const i = stack.indexOf(l); if (i >= 0) stack.splice(i, 1); }
    flush();
    return;
  }
  // The browser has already moved back one entry: the top layer is the one Back meant.
  const top = stack.pop();
  if (top && !top.dead) top.onBack();
  // Left over from before a reload: an entry of ours with no layer behind it any more. Step past it,
  // or that Back press would appear to do nothing.
  else if (!top && (e.state as { minamiLayer?: number } | null)?.minamiLayer) history.back();
  queueMicrotask(flush);
}

/** While `open`, Back calls `onBack` (which should close the layer) instead of leaving the page. */
export function useBackLayer(open: boolean, onBack: () => void) {
  const cb = useRef(onBack);
  cb.current = onBack;
  useEffect(() => {
    if (!open) return;
    if (!wired) { wired = true; window.addEventListener("popstate", onPop); document.addEventListener("click", onClick, true); }
    const layer: Layer = { id: ++seq, onBack: () => cb.current(), dead: false, path: location.pathname };
    stack.push(layer);
    history.pushState({ minamiLayer: layer.id }, "");
    return () => {
      // Still stacked = closed by the UI, not by Back (onPop removes it first).
      if (stack.includes(layer)) { layer.dead = true; queueMicrotask(flush); }
    };
  }, [open]);
}
