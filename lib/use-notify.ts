"use client";
// Away-tab notifications: when a pane finishes a turn, or needs your approval/answer, while you're on
// another tab or app, say so — a native Notification (if permitted) plus a flashing tab title, both of
// which clear the moment you come back. This is deliberately NOT tied to any one pane's React tree
// (several panes can fire it) so it's a tiny module-level event bus + one hook mounted once at the top.
import { useEffect, useRef } from "react";

const EVT = "minami:notify";
let permissionAsked = false;

/** Call from a user gesture (e.g. the Send click) — browsers are inconsistent about honoring
 *  Notification.requestPermission() outside one, so this is deliberately NOT called on mount. */
export function ensureNotifyPermission() {
  if (typeof window === "undefined" || typeof Notification === "undefined" || permissionAsked) return;
  permissionAsked = true;
  if (Notification.permission === "default") Notification.requestPermission().catch(() => {});
}

/** Fire an away-notification. Silently does nothing if the tab is already visible and focused — the
 *  whole point is to surface things you'd otherwise miss, not to nag you while you're looking right at it. */
export function notify(title: string, body?: string) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const n = new Notification(title, { body, silent: false });
      n.onclick = () => { try { window.focus(); } catch { /* ignore */ } };
    }
  } catch { /* ignore — notifications are a nice-to-have, never worth breaking on */ }
  window.dispatchEvent(new CustomEvent(EVT, { detail: { title } }));
}

/** Mount ONCE near the root. Flashes the document title between `baseTitle` and whatever notify() fires
 *  until the tab regains focus/visibility, so a background pane finishing shows up even if you're deep
 *  in another app and only glance at the taskbar/tab strip. */
export function useTitleFlash(baseTitle: string) {
  const savedTitle = useRef(baseTitle);
  const flashing = useRef(false);

  useEffect(() => {
    savedTitle.current = baseTitle;
    if (!flashing.current && typeof document !== "undefined") document.title = baseTitle;
  }, [baseTitle]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let iv: ReturnType<typeof setInterval> | null = null;
    let latest = "";
    const stop = () => {
      if (iv) clearInterval(iv);
      iv = null;
      flashing.current = false;
      document.title = savedTitle.current;
    };
    const onNotify = (e: Event) => {
      latest = (e as CustomEvent<{ title?: string }>).detail?.title || "Minami";
      if (flashing.current) return;
      flashing.current = true;
      let on = false;
      iv = setInterval(() => {
        on = !on;
        document.title = on ? `● ${latest}` : savedTitle.current;
      }, 1000);
    };
    const onVisible = () => { if (document.visibilityState === "visible") stop(); };
    window.addEventListener(EVT, onNotify);
    window.addEventListener("focus", stop);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(EVT, onNotify);
      window.removeEventListener("focus", stop);
      document.removeEventListener("visibilitychange", onVisible);
      if (iv) clearInterval(iv);
    };
  }, []);
}
