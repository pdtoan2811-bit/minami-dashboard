"use client";
// Open a localhost link from wherever the dashboard is being READ (§23).
//
// Replies say `http://localhost:3021` because that is true on the box. Read on the phone, the same
// href opens the phone's own localhost. So when the page itself isn't on loopback, a localhost link is
// re-pointed at the tailnet: the server finds (or creates) the `tailscale serve` entry for that port
// and the tab goes there instead. On the box nothing changes — the link opens as written.

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/;

export function isLoopbackUrl(href: string): boolean {
  try { const u = new URL(href); return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK.test(u.hostname); }
  catch { return false; }
}

/** True when this page is being viewed from another device (phone over the tailnet, a LAN laptop). */
export function viewedRemotely(): boolean {
  return typeof window !== "undefined" && !LOOPBACK.test(window.location.hostname);
}

/** The tailnet address for a localhost URL — finds or creates its `tailscale serve` entry. */
export async function tailnetUrl(href: string): Promise<string> {
  const u = new URL(href);
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const r = await fetch("/api/tailnet/expose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ port }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.base) throw new Error(j.error || `HTTP ${r.status}`);
  return j.base + u.pathname + u.search + u.hash;
}

/** Fired instead of opening a tab on a phone; BentoHome renders components/PreviewOverlay.tsx. */
export const PREVIEW_EVENT = "minami:preview";

/** Handles the click if it needs handling; returns false to let the caller open the link as usual.
 *  Call it synchronously from the click handler — the blank tab has to open inside the user gesture,
 *  because a window.open after an await is a popup, and mobile Chrome blocks those silently. */
export function openLocalUrl(href: string): boolean {
  if (!viewedRemotely() || !isLoopbackUrl(href)) return false;
  // On a phone the preview opens INSIDE the app. A new tab from the installed app is a Chrome tab in
  // another task, so Back there closed it and left you on Chrome or the home screen, never back in the
  // chat you came from. In-app, Back walks the preview's own pages and then closes it (§23).
  if (window.matchMedia("(hover: none) and (pointer: coarse)").matches) {
    window.dispatchEvent(new CustomEvent(PREVIEW_EVENT, { detail: href }));
    return true;
  }
  const port = new URL(href).port || "80";
  const w = window.open("", "_blank");
  if (!w) return false;
  w.opener = null;
  w.document.title = `opening :${port}…`;
  w.document.body.style.cssText = "font:14px system-ui;background:#111;color:#bbb;padding:24px";
  w.document.body.textContent = `Finding localhost:${port} on the tailnet…`;
  tailnetUrl(href)
    .then((url) => w.location.replace(url))
    .catch((e: Error) => { w.document.body.textContent = `Couldn't open localhost:${port} from this device — ${e.message}`; });
  return true;
}
