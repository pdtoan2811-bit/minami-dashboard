"use client";
// The client half of the alert system: poll /api/events, keep the last N in memory, fire an away-tab
// toast for anything genuinely new, and expose an unread count for the bell.
//
// TWO CURSORS, BOTH TIMESTAMPS, BOTH IN localStorage:
//   notifiedTs — the newest event we have already fired an OS notification for.
//   seenTs     — the newest event Thomas has actually looked at (set when he opens the bell).
//
// They are separate because they answer different questions, and conflating them breaks the case this
// whole feature exists for. A deploy restarts the server: this page reloads or re-mounts, refetches
// the last 50 events, and finds the "deploy live" event that landed while :3000 was down. That event
// must still be *unread* (seenTs) and must still *toast* (notifiedTs) — but on the next remount it
// must do neither. One cursor cannot express that; two can.
//
// Storing timestamps rather than an id set also means the state is two numbers, so two open tabs
// racing on the same localStorage key can at worst cost one duplicate-suppressed toast, never a
// corrupt list.
import { useCallback, useEffect, useRef, useState } from "react";
import { notify } from "./use-notify";

export type EventLevel = "info" | "success" | "warn" | "error";
export type MinamiEvent = {
  id: string; ts: number; kind: string; level: EventLevel; title: string; body?: string;
  meta?: Record<string, unknown>;
};

const K_NOTIFIED = "minami.events.notifiedTs";
const K_SEEN = "minami.events.seenTs";
const POLL_MS = 8000;
const KEEP = 50;

const num = (k: string) => { try { return Number(localStorage.getItem(k) || 0) || 0; } catch { return 0; } };
const setNum = (k: string, v: number) => { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } };

export function useEvents() {
  const [events, setEvents] = useState<MinamiEvent[]>([]);
  const [seenTs, setSeenTs] = useState(0);
  // First poll must not toast the entire backlog at you — but it also must not silently swallow the
  // deploy event you were waiting for. `notifiedTs` is what distinguishes the two, so it is read from
  // storage *before* the first response is processed, never derived from it.
  const notifiedTs = useRef(0);
  const hydrated = useRef(false);

  useEffect(() => {
    notifiedTs.current = num(K_NOTIFIED);
    setSeenTs(num(K_SEEN));
    hydrated.current = true;
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!hydrated.current) return;
      try {
        const r = await fetch(`/api/events?limit=${KEEP}`, { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { events?: MinamiEvent[] };
        if (!alive || !Array.isArray(d.events)) return;

        // REPLACE, not merge — the server's answer is the whole truth about the last KEEP events, so
        // there is no client-side accumulation that can disagree with it (same rule as activity state).
        setEvents(d.events);

        const fresh = d.events.filter((e) => e.ts > notifiedTs.current);
        if (fresh.length) {
          // A browser profile that has never seen this dashboard has notifiedTs = 0, so *every* event
          // on disk looks fresh. Adopt the backlog silently instead of announcing it: nothing about a
          // week-old deploy is news. They still count as unread in the bell (that's `seenTs`, which is
          // a different question) — this only suppresses the toast.
          const firstEverPoll = notifiedTs.current === 0;
          notifiedTs.current = Math.max(...fresh.map((e) => e.ts));
          setNum(K_NOTIFIED, notifiedTs.current);
          if (firstEverPoll) return;
          // One toast per event up to three, then a summary — a failed deploy plus its build events
          // arriving together should not stack four OS notifications on top of each other.
          if (fresh.length <= 3) for (const e of fresh) notify(e.title, e.body || undefined);
          else notify(`${fresh.length} new updates`, fresh.slice(-3).map((e) => e.title).join(" · "));
        }
      } catch { /* server mid-restart is the expected failure here, not an exception */ }
    };
    tick();
    const iv = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const markSeen = useCallback(() => {
    const newest = events.reduce((m, e) => Math.max(m, e.ts), 0);
    if (!newest) return;
    setSeenTs(newest);
    setNum(K_SEEN, newest);
  }, [events]);

  const unread = events.filter((e) => e.ts > seenTs).length;
  // Newest-first for display; the API speaks oldest-first because that is the order it was written in.
  return { events: [...events].reverse(), unread, markSeen };
}
