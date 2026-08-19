"use client";
// WHAT IS ACTUALLY HAPPENING — a toggleable trace of every leg of the pipeline.
//
// Almost every bug in this project has had the same shape: audio flowing, HTTP 200s everywhere, clean
// logs, and a board that is blank, stale, or full of things nobody said. A glossary became a fake
// meeting; a publish 401'd for twenty minutes; the judge sat on the response path and put the board
// two chunks behind. In each case the information that would have identified it in seconds existed —
// in a terminal anh was not reading, on a machine he was mid-call on.
//
// So the trace goes ON THE CANVAS, behind a toggle. Not a log file: a panel he can open while the
// thing is going wrong, showing each chunk as it moves through hear → correct → judge → paint, with
// the time each leg took and the reason anything was dropped.
//
// ── Why it is off by default and lives bottom-left ─────────────────────────────────────────────
// This tab gets screen-shared. A customer should never see a debug rail, so it is opt-in, remembered
// per browser, and sits opposite the dock so the two never fight for the same corner.

import { useEffect, useRef, useState } from "react";

// One definition, shared with the server that produces these — a second copy here is how the colour
// map and the emitter drift apart until an event silently renders with no tint.
import type { TraceEvent } from "@/lib/canvas-trace";

const TINT: Record<TraceEvent["kind"], string> = {
  hear: "#2a78d6", correct: "#6d5ae0", judge: "#159d6b", tidy: "#0e8c8c",
  paint: "#78716c", skip: "#c47f18", error: "#c4486a", command: "#b4638a",
};

export function DebugPanel() {
  const [on, setOn] = useState(false);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // Remembered per browser: anh turns it on because something is wrong, and a reload in the middle of
  // diagnosing should not throw the tool away.
  useEffect(() => {
    try { setOn(localStorage.getItem("minami:debug") === "1"); } catch { /* private mode */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem("minami:debug", on ? "1" : "0"); } catch { /* ignore */ }
  }, [on]);

  /** Polls the server's ring buffer rather than opening a second SSE stream. The board's own stream is
   *  the one that must never be disturbed — adding a second subscriber to debug the first is how you
   *  end up debugging the debugger. 1.5s is fast enough to watch a chunk move through the legs. */
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/canvas/trace", { cache: "no-store" });
        /** ⚠️ SAY SO WHEN THE TRACE ITSELF IS THE THING THAT IS BROKEN. A 401 here — which is what
         *  happens if the board is reached through a tunnel, where CANVAS_LOCAL_CONTROL is
         *  deliberately off — would otherwise render as "nothing yet", i.e. a panel calmly reporting
         *  that a busy pipeline is idle. That is the exact failure this whole panel exists to end, and
         *  it would be absurd to ship it inside the panel. */
        if (!r.ok) {
          if (alive) setError(r.status === 401 ? "trace is not readable from here (401)" : `trace unavailable (HTTP ${r.status})`);
          return;
        }
        const d = await r.json();
        if (alive && Array.isArray(d.events)) { setError(null); setEvents(d.events); }
      } catch (e) {
        // Never rethrown: the trace failing must not affect the board. Shown, though.
        if (alive) setError(`trace unreachable — ${e instanceof Error ? e.message : "network error"}`);
      }
    };
    void tick();
    const t = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [on]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [events]);

  return (
    <>
      <button
        onClick={() => setOn((v) => !v)}
        title="Show what the pipeline is doing"
        /* ⚠️ STACKED ABOVE THE PRESENCE PILL, NOT BESIDE IT. The pill occupies left 36 / bottom 36 and
           is 42 tall (measured, not guessed), so the obvious `bottom-4 left-4` put this button directly
           underneath it. Left-aligned to the same 36px so the two read as one column rather than as two
           things that happen to share a corner. */
        className="absolute bottom-[86px] left-9 z-40 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors"
        style={on
          ? { background: "#111827", color: "#fff", borderColor: "#111827" }
          : { background: "rgba(255,255,255,0.8)", color: "#9ca3af", borderColor: "rgba(0,0,0,0.08)" }}
      >
        debug
      </button>

      {on ? (
        <div className="absolute bottom-[121px] left-9 z-40 w-[420px] rounded-xl border border-neutral-200 bg-white/95 p-2.5 shadow-[0_12px_36px_-16px_rgba(16,24,40,0.45)] backdrop-blur-xl">
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Pipeline</span>
            <span className="text-[11px] tabular-nums text-neutral-400">{events.length} events</span>
            <span className="flex-1" />
            <button onClick={() => setOn(false)} className="text-[13px] leading-none text-neutral-300 hover:text-neutral-700">×</button>
          </div>
          <div ref={box} className="max-h-[300px] space-y-0.5 overflow-y-auto font-mono text-[11px] leading-[1.45]">
            {events.map((e, i) => (
              <div key={i} className="flex gap-1.5">
                <span className="shrink-0 text-neutral-300 tabular-nums">
                  {new Date(e.at).toLocaleTimeString("en-GB", { hour12: false })}
                </span>
                <span className="w-[52px] shrink-0 font-semibold" style={{ color: TINT[e.kind] }}>{e.kind}</span>
                <span className="min-w-0 flex-1 break-words text-neutral-700">{e.text}</span>
                {typeof e.ms === "number" ? (
                  <span
                    className="shrink-0 tabular-nums"
                    // Red past the chunk window: that is the number that decides whether the board can
                    // keep up with speech at all, so it should be impossible to miss.
                    style={{ color: e.ms > 10000 ? "#c4486a" : "#a3a3a3" }}
                  >{(e.ms / 1000).toFixed(1)}s</span>
                ) : null}
              </div>
            ))}
            {error ? <p style={{ color: "#c4486a" }}>{error}</p> : null}
            {!events.length && !error ? <p className="text-neutral-400">nothing yet — start talking</p> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
