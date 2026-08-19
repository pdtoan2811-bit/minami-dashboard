// THE PIPELINE TRACE — a small ring buffer the canvas can read.
//
// Every leg of ingest pushes here; the debug panel polls it. On globalThis for the same reason the
// board and the sessions are: a Next dev hot-reload must not wipe the evidence of the thing anh is
// currently trying to diagnose.
//
// Bounded at 200 events, because this must never be the reason a long meeting runs out of memory —
// and 200 covers several minutes, which is the window in which anyone actually looks.

export type TraceEvent = {
  at: number;
  kind: "hear" | "correct" | "judge" | "tidy" | "paint" | "skip" | "error" | "command";
  text: string;
  ms?: number;
};

const MAX = 200;

export function traceBuffer(): TraceEvent[] {
  const g = globalThis as { __canvasTrace?: TraceEvent[] };
  return (g.__canvasTrace ??= []);
}

/** Called from the ingest hot path. Never throws: a broken trace must not break a meeting. */
export function trace(kind: TraceEvent["kind"], text: string, ms?: number) {
  try {
    const b = traceBuffer();
    b.push({ at: Date.now(), kind, text: String(text).slice(0, 600), ...(ms !== undefined ? { ms } : {}) });
    if (b.length > MAX) b.splice(0, b.length - MAX);
  } catch { /* tracing is never load-bearing */ }
}
