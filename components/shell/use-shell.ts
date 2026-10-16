"use client";
// The shell's state (§30): the /api/shell poll, and the one switch a page uses to take the whole
// screen (a phone chat, where the composer owns the bottom edge and the keyboard owns the rest).
import { createContext, useContext, useEffect, useState } from "react";
import type { ShellData } from "@/app/api/shell/route";

// ── one poll for every reader ──────────────────────────────────────────────────────────────────────
// The rail's badge, the drawer and Bento's Day strip all read this. A module-level store, so three
// readers on one page still make one request (see the route's note on Chrome's connection budget).
const POLL_MS = 6000;
let data: ShellData | null = null;
const readers = new Set<(d: ShellData | null) => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = false;

async function tick() {
  timer = null;
  // A hidden tab doesn't poll: the phone app sits backgrounded for hours, and its badge is redrawn the
  // moment it comes back (the visibilitychange listener below).
  if (document.visibilityState === "visible" && !inflight) {
    inflight = true;
    try {
      const r = await fetch("/api/shell", { cache: "no-store" });
      const j = await r.json();
      if (!j.error) { data = j as ShellData; for (const fn of readers) fn(data); }
    } catch { /* server restarting (a deploy): keep the last reading */ }
    inflight = false;
  }
  if (readers.size && !timer) timer = setTimeout(tick, POLL_MS);
}
function onVisible() { if (document.visibilityState === "visible" && readers.size) { if (timer) clearTimeout(timer); tick(); } }

/** Refetch now — after a capture or an action that changes what the shell shows. */
export function refreshShell() { if (typeof document !== "undefined" && readers.size) { if (timer) clearTimeout(timer); tick(); } }

export function useShellData(): ShellData | null {
  const [d, setD] = useState<ShellData | null>(data);
  useEffect(() => {
    readers.add(setD);
    if (readers.size === 1) { document.addEventListener("visibilitychange", onVisible); tick(); }
    else setD(data);
    return () => {
      readers.delete(setD);
      if (!readers.size) { document.removeEventListener("visibilitychange", onVisible); if (timer) clearTimeout(timer); timer = null; }
    };
  }, []);
  return d;
}

// ── chrome ─────────────────────────────────────────────────────────────────────────────────────────
// A page that needs the full screen on a phone (Bento with a chat open) says so; the shell then drops
// its top strip and bottom bar. Context rather than a setting: it is per-page, per-moment UI state,
// and must reset the instant the page unmounts (a stale "hidden" would strand you with no nav).
export type ShellCtx = { setFullscreen: (on: boolean) => void };
export const ShellContext = createContext<ShellCtx>({ setFullscreen: () => {} });

export function useShellFullscreen(on: boolean) {
  const { setFullscreen } = useContext(ShellContext);
  useEffect(() => { setFullscreen(on); return () => setFullscreen(false); }, [on, setFullscreen]);
}
