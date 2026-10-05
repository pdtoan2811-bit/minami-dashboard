// Minami Bento service worker — web push only (§24, docs/knowledge/24-push.md).
//
// There is deliberately NO fetch handler. A worker that caches HTML/JS would pin the installed app to
// whatever build it cached, which is exactly the "phone keeps running the old build" bug §23 fixed with
// lib/use-build-refresh.ts — that fix relies on the network answering /api/build and the reload getting
// fresh HTML. With no fetch listener, every request goes straight to the network as if this file did
// not exist (Chrome also skips starting the worker for navigations at all).
//
// The payload format is written by lib/push/notifier.ts (PushPayload) — keep the two in step.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let p;
  try { p = event.data ? event.data.json() : null; } catch { p = null; }
  if (!p) return;
  event.waitUntil(handle(p));
});

async function handle(p) {
  if (p.t === "close") {
    const open = await self.registration.getNotifications({ tag: p.tag });
    open.forEach((n) => n.close());
    return;
  }
  if (p.t !== "show") return;
  await self.registration.showNotification(p.title || "Minami", {
    body: p.body || "",
    tag: p.tag,
    // One notification per chat: the tag replaces, and renotify decides whether the replacement buzzes.
    // renotify must be false when silent — a silent update that re-alerts is a contradiction Chrome
    // resolves in favour of the buzz.
    renotify: !p.silent,
    silent: !!p.silent,
    requireInteraction: false,
    timestamp: p.ts || Date.now(),
    icon: "/app-icon-192.png",
    badge: "/app-icon-192.png",
    actions: (p.actions || []).slice(0, 2),
    data: { url: p.url || "/", sessionId: p.sessionId || null, nonces: p.nonces || {} },
  });
}

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  const nonce = event.action && data.nonces ? data.nonces[event.action] : null;
  event.waitUntil(nonce ? runAction(nonce, data) : openApp(data));
});

// A button that settles the prompt from the lock screen. Anything other than a clean success (already
// answered in the app, nonce expired, server mid-deploy) falls back to opening the chat, so a tap is
// never silently swallowed.
async function runAction(nonce, data) {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    const r = await fetch("/api/push/act", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify({ nonce, endpoint: sub ? sub.endpoint : "" }),
    });
    if (r.ok) return;
  } catch { /* fall through */ }
  return openApp(data);
}

// Focus the app if it is already running, else open it at /?open=<sessionId>. A running page is asked
// first (postMessage, see lib/push-client.ts) so it can switch chats in place without a reload; only if
// it doesn't acknowledge is it navigated. focus() comes first because the click's permission to raise a
// window is short-lived, and waiting on the ack before it could forfeit that.
async function openApp(data) {
  const url = new URL(data.url || "/", self.location.origin).href;
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const win = wins.find((c) => c.visibilityState === "visible") || wins[0];
  if (!win) return self.clients.openWindow(url);
  try { await win.focus(); } catch { /* not allowed — still try to route it */ }
  if (!data.sessionId) return;
  const acked = await new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(false), 700);
    ch.port1.onmessage = () => { clearTimeout(t); resolve(true); };
    try { win.postMessage({ type: "minami:open", sessionId: data.sessionId }, [ch.port2]); } catch { clearTimeout(t); resolve(false); }
  });
  if (!acked && "navigate" in win) {
    try { await win.navigate(url); } catch { return self.clients.openWindow(url); }
  }
}

// The push service rotated this device's subscription. Re-subscribe with the same server key and tell
// the server which endpoint it replaces, so the device's prefs carry over instead of resetting.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      let sub = event.newSubscription;
      if (!sub) {
        const { publicKey } = await (await fetch("/api/push/key")).json();
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
      }
      await fetch("/api/push/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), replaces: event.oldSubscription ? event.oldSubscription.endpoint : undefined }),
      });
    } catch { /* the page re-syncs its subscription on the next open (usePushRegistration) */ }
  })());
});
