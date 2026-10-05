"use client";
import { useEffect } from "react";

// Reload a page that is running an older build than the server (§23).
//
// The installed Android app is a long-lived page: Android keeps it in memory between uses, so after a
// deploy it went on running the JavaScript it loaded days ago — no chat bar, no Back handling — while
// every fresh tab got the new build. Nothing told it. A desktop tab has the same problem, but someone
// at a desk reloads by reflex; nobody reloads an app.
//
// Checked when the page comes back to the foreground (the moment an app is "opened"), not on a timer:
// a reload mid-read would yank the transcript out from under you, and a page in the background has no
// reason to be current until it is looked at. Safe to reload then — drafts persist to localStorage per
// pane, and the open topic and panes are restored the same way a server restart restores them.
const MINE = process.env.MINAMI_BUILD || "";

export function useBuildRefresh() {
  useEffect(() => {
    if (!MINE) return;
    let busy = false;
    const check = async () => {
      if (document.visibilityState !== "visible" || busy) return;
      busy = true;
      try {
        const r = await fetch("/api/build", { cache: "no-store" });
        const { build } = await r.json();
        if (build && build !== MINE) location.reload();
      } catch { /* server mid-restart: the next foregrounding asks again */ }
      busy = false;
    };
    document.addEventListener("visibilitychange", check);
    // pageshow covers a restore from the back/forward cache, which fires no visibilitychange.
    window.addEventListener("pageshow", check);
    return () => { document.removeEventListener("visibilitychange", check); window.removeEventListener("pageshow", check); };
  }, []);
}
