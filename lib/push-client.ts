"use client";
// Browser half of web push (§24): register public/sw.js, subscribe this device, tell the server which
// chat is on screen, and route a notification tap into the running page.
import { useEffect, useRef, useState } from "react";

export type PushState = "unsupported" | "denied" | "off" | "on";

export const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;

const keyBytes = (b64u: string) => {
  const s = atob(b64u.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64u.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function registration(): Promise<ServiceWorkerRegistration> {
  // updateViaCache "none": the worker script is checked against the network on every navigation's
  // update check, so a fixed sw.js reaches the phone with the next deploy (next.config.mjs also sends
  // it no-cache — belt and braces, since the installed app is a long-lived page).
  await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return (await currentSubscription()) ? "on" : "off";
}

/** Must be called from a tap: Chrome only shows the permission prompt inside a user gesture. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "off";
  const reg = await registration();
  const { publicKey } = await (await fetch("/api/push/key", { cache: "no-store" })).json();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made against a different server key (push.json deleted, keys regenerated) can't
  // be sent to — the push service rejects the VAPID mismatch. Replace it rather than reuse it.
  const k = sub?.options?.applicationServerKey;
  if (sub && k && btoa(String.fromCharCode(...new Uint8Array(k))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== publicKey) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `subscribe failed (${r.status})`);
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const sub = await currentSubscription();
  if (sub) {
    await fetch("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  return pushSupported() ? "off" : "unsupported";
}

/** The "finished" notices for THIS device — a desk browser and a phone can differ. */
export async function getFinishedPref(): Promise<boolean> {
  const sub = await currentSubscription();
  if (!sub) return true;
  const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
  return (await r.json().catch(() => ({})))?.finished !== false;
}
export async function setFinishedPref(finished: boolean): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), finished }) });
}

/**
 * Call once from the main page. If this device already granted notifications, it (re)registers the
 * worker and re-sends the subscription — cheap, and it heals a server that lost push.json or a
 * subscription the push service rotated while no worker was awake to catch it. It never PROMPTS:
 * that needs a tap, which is PushToggle's job.
 *
 * `onOpen(sessionId)` receives notification taps while the page is running. Return without throwing
 * and the worker counts it handled; if no onOpen is given, the worker navigates to /?open=<id> instead.
 */
export function usePushRegistration(opts?: { onOpen?: (sessionId: string) => void }): PushState {
  const [state, setState] = useState<PushState>("off");
  const onOpen = useRef(opts?.onOpen);
  onOpen.current = opts?.onOpen;
  useEffect(() => {
    if (!pushSupported()) { setState("unsupported"); return; }
    let live = true;
    (async () => {
      if (Notification.permission === "granted") {
        try {
          const reg = await registration();
          const sub = await reg.pushManager.getSubscription();
          if (sub) await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
        } catch { /* offline or mid-deploy — the next load tries again */ }
      }
      if (live) setState(await pushState());
    })();
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type !== "minami:open" || !onOpen.current) return;
      onOpen.current(String(e.data.sessionId));
      e.ports?.[0]?.postMessage("ok"); // the ack: no ack within 700ms and the worker navigates instead
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => { live = false; navigator.serviceWorker.removeEventListener("message", onMsg); };
  }, []);
  return state;
}

/**
 * Tell the server which chat is on screen, so it doesn't buzz the phone about the question you are
 * reading. Pings every 30s while the page is visible (the server's window is 45s), and says "gone" the
 * moment the page is hidden — via sendBeacon, which survives the page being frozen right after.
 * Pass null when no chat is focused.
 */
export function usePushPresence(sessionId: string | null | undefined) {
  useEffect(() => {
    if (!sessionId || typeof document === "undefined") return;
    const post = (gone: boolean) => {
      const body = JSON.stringify({ sessionId, gone });
      if (gone && navigator.sendBeacon) navigator.sendBeacon("/api/push/presence", new Blob([body], { type: "application/json" }));
      else fetch("/api/push/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
    };
    const ping = () => { if (document.visibilityState === "visible") post(false); };
    const onVis = () => (document.visibilityState === "visible" ? post(false) : post(true));
    ping();
    const t = setInterval(ping, 30_000);
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); post(true); };
  }, [sessionId]);
}
