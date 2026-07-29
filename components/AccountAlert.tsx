"use client";

// Top-right alert that fires when Claude Code has fallen off the preferred account
// (oedevai2@gmail.com) back onto the fallback (pdtoan2811@gmail.com).
//
// Why this exists: token-slayer silently auto-fails-over to a READY slot when the active one's
// credential dies, and nothing in the UI says so — you just quietly start burning the wrong
// account's weekly limit for hours. Observed live on 2026-07-29: a `switch oedevai2` reported
// success, then the session was back on pdtoan2811 minutes later with no signal anywhere.
//
// Trigger comes from /api/accounts's `live` block, which reads ~/.claude.json's oauthAccount —
// the identity Claude Code actually authenticated with — NOT token-slayer's own `active` label,
// which has been caught claiming the wrong account. See that route for the full reasoning.

import { useCallback, useEffect, useRef, useState } from "react";

type Live = {
  email: string | null;
  displayName: string | null;
  preferred: string;
  offPreferred: boolean;
  claimsMismatch: boolean;
};

const POLL_MS = 30_000;

export function AccountAlert() {
  const [live, setLive] = useState<Live | null>(null);
  const [switching, setSwitching] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Which specific "we're off-account" episode the user dismissed. Keyed by the offending email so
  // dismissing a pdtoan2811 fallback doesn't also pre-suppress a *different* account later, and so
  // falling off → back on → off again re-alerts instead of staying silently hidden forever.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const prevOff = useRef(false);

  const load = useCallback(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((d: { live?: Live; error?: string }) => {
        if (!d?.live) return; // route errored (token-slayer missing on this host) — stay silent
        setLive(d.live);
        // Re-arm on a fresh transition: if we were ON the preferred account and just fell off,
        // clear any earlier dismissal so this new episode actually shows.
        if (d.live.offPreferred && !prevOff.current) setDismissed(null);
        prevOff.current = d.live.offPreferred;
      })
      .catch(() => { /* offline / route down — nothing useful to say */ });
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    // Coming back to the tab is exactly when you want to know you've been on the wrong account.
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  const switchBack = useCallback(async () => {
    if (!live) return;
    setSwitching(true);
    setNote(null);
    try {
      const r = await fetch("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: live.preferred }),
      });
      const d = await r.json();
      if (!r.ok) { setNote(d?.error || "switch failed"); return; }
      // Don't trust the CLI's "Switched to …" — re-read the real identity and let the banner
      // decide for itself whether it should still be up. A switch that reports success while the
      // credential is dead is the exact failure mode this component was built for.
      await new Promise((res) => setTimeout(res, 800));
      const verify = await fetch("/api/accounts").then((x) => x.json()).catch(() => null);
      if (verify?.live) {
        setLive(verify.live);
        prevOff.current = verify.live.offPreferred;
        if (verify.live.offPreferred) setNote("switch reported success but the account didn't change — the credential is probably dead");
      }
    } catch (e) {
      setNote(String((e as Error)?.message || e));
    } finally {
      setSwitching(false);
    }
  }, [live]);

  const showing = live?.offPreferred && dismissed !== live.email;
  if (!showing || !live) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      className="fixed right-3 top-3 z-[100] w-[min(22rem,calc(100vw-1.5rem))] animate-[slideIn_.25s_ease-out] rounded-xl border border-amber-300/70 bg-amber-50/95 p-3 shadow-lg backdrop-blur dark:border-amber-500/40 dark:bg-amber-950/90"
    >
      <style>{`@keyframes slideIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}`}</style>

      <div className="flex items-start gap-2.5">
        <span aria-hidden className="mt-px text-base leading-none">⚠️</span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-amber-900 dark:text-amber-100">
            Running on the fallback account
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-800/90 dark:text-amber-200/80">
            Claude Code is authenticated as{" "}
            <span className="font-medium tabular-nums">{live.email}</span>, not{" "}
            <span className="font-medium tabular-nums">{live.preferred}</span>.
          </p>
          {live.claimsMismatch && (
            <p className="mt-1 text-[10px] leading-relaxed text-amber-700/80 dark:text-amber-300/70">
              token-slayer still claims it&rsquo;s on the preferred slot — its status banner is out of
              sync with the real credential.
            </p>
          )}
          {note && (
            <p className="mt-1.5 rounded-md bg-amber-200/50 px-1.5 py-1 text-[10px] leading-relaxed text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
              {note}
            </p>
          )}

          <div className="mt-2 flex items-center gap-1.5">
            <button
              onClick={switchBack}
              disabled={switching}
              className="rounded-md bg-amber-600 px-2 py-1 text-[11px] font-medium text-white transition hover:bg-amber-700 disabled:opacity-50"
            >
              {switching ? "switching…" : `switch to ${live.preferred.split("@")[0]}`}
            </button>
            <button
              onClick={() => setDismissed(live.email)}
              className="rounded-md px-2 py-1 text-[11px] text-amber-800/70 transition hover:bg-amber-200/50 dark:text-amber-200/60 dark:hover:bg-amber-900/40"
            >
              dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
