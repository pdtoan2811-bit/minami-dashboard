"use client";

import { useEffect, useState } from "react";
import type { BlacksmithState } from "./client";

// One poller for the whole page, shared by every consumer.
//
// The alternative — a `useEffect` fetch inside each component — looked fine with one panel and falls
// over the moment the bento grid renders a badge per tile: twenty tiles would mean twenty requests
// every five seconds for one identical answer, and each of those makes `smith ui serve` re-project the
// event log. So the poller lives at module scope, refcounted by mount, and hands the same object to
// everyone.

const LIVE_MS = 5000;
// When the factory isn't there, back off hard. Most installs have no Blacksmith at all, and a
// dashboard that fires a doomed request every five seconds forever is a bug even if nothing notices.
const DOWN_MS = 30_000;

let state: BlacksmithState | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let refs = 0;
const subs = new Set<(s: BlacksmithState | null) => void>();

async function poll() {
  try {
    const d = (await fetch("/api/blacksmith", { cache: "no-store" }).then((r) => r.json())) as BlacksmithState;
    state = d;
    for (const f of subs) f(d);
  } catch {
    // Keep the last good state. A failed fetch to our OWN api route says nothing about the factory,
    // and blanking the panel on a transient blip would itself read as "Blacksmith stopped".
  }
  // Re-armed at the end rather than on an interval: an interval would stack requests if one poll ever
  // outlived its period, which the 2.5s upstream timeout makes possible.
  if (refs > 0) timer = setTimeout(poll, state?.up ? LIVE_MS : DOWN_MS);
}

/** Current factory state, or null before the first response. Shares one poller across all callers. */
export function useBlacksmith(): BlacksmithState | null {
  const [s, setS] = useState<BlacksmithState | null>(state);
  useEffect(() => {
    subs.add(setS);
    refs++;
    if (refs === 1) { if (timer) clearTimeout(timer); void poll(); }
    else if (state) setS(state); // late joiner gets the current answer without waiting for a tick
    return () => {
      subs.delete(setS);
      refs--;
      if (refs === 0 && timer) { clearTimeout(timer); timer = null; }
    };
  }, []);
  return s;
}

/** Does this folder look like the target of a Blacksmith epic?
 *
 *  Matched on basename, not path. Blacksmith records a target only as a bare `project` string and
 *  anchors every file it writes to its own clone, so the checkout it is building can live anywhere on
 *  disk — there is no path to compare against. */
export function projectMatches(cwd: string, projects: string[]): boolean {
  const base = cwd.replace(/\/+$/, "").split("/").pop();
  return !!base && projects.includes(base);
}
