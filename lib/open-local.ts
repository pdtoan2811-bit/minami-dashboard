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

/** Handles the click if it needs handling; returns false to let the caller open the link as usual.
 *  Call it synchronously from the click handler — the blank tab has to open inside the user gesture,
 *  because a window.open after an await is a popup, and mobile Chrome blocks those silently. */
export function openLocalUrl(href: string): boolean {
  if (!viewedRemotely() || !isLoopbackUrl(href)) return false;
  const u = new URL(href);
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const w = window.open("", "_blank");
  if (!w) return false;
  w.opener = null;
  w.document.title = `opening :${port}…`;
  w.document.body.style.cssText = "font:14px system-ui;background:#111;color:#bbb;padding:24px";
  w.document.body.textContent = `Finding localhost:${port} on the tailnet…`;
  fetch("/api/tailnet/expose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ port }) })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.base) throw new Error(j.error || `HTTP ${r.status}`);
      w.location.replace(j.base + u.pathname + u.search + u.hash);
    })
    .catch((e: Error) => { w.document.body.textContent = `Couldn't open localhost:${port} from this device — ${e.message}`; });
  return true;
}
