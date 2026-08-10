"use client";
// The operator panel: what was heard, and what Minami did about it.
//
// NOT part of the screen share. Recall streams /canvas; this exists so you can watch the transcript
// and the canvas react in the same glance, which two windows can't give you.
//
// Actions render inline under the line that caused them, not in a separate log. A log answers "what
// happened"; inline answers "why" — did she keep the right line, did the camera move at the right
// moment. That is the thing you are actually judging.
import { useEffect, useRef } from "react";
import { STATE_COLOR } from "@/lib/canvas-graph";

export type Applied = { op: string; kind?: string; label?: string };
export type Segment = { at: string; lines: string[]; actions: Applied[]; dropped: number };

export const DURATIONS = [
  { label: "1 min", minutes: 1 },
  { label: "2 min", minutes: 2 },
  { label: "5 min", minutes: 5 },
  { label: "10 min", minutes: 10 },
  { label: "All", minutes: 0 },
];

export function TranscriptPanel({
  segments, running, minutes, progress, error, onRun, onStop,
}: {
  segments: Segment[];
  running: boolean;
  minutes: number;
  /** chunks done / total, so a long run doesn't look hung. */
  progress: { done: number; total: number } | null;
  error?: string | null;
  onRun: (minutes: number) => void;
  onStop: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  // Follow the stream — a transcript you have to babysit isn't one.
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [segments.length]);

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <aside className="flex h-dvh w-[390px] shrink-0 flex-col border-l border-neutral-200/80 bg-white/75 backdrop-blur-xl">
      <header className="border-b border-neutral-200/80 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-bold uppercase tracking-[0.13em] text-neutral-400">Live transcript</span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="size-1.5 rounded-full" style={{ background: running ? STATE_COLOR.agreed : "#c4c4c0" }} />
            <span className="text-[11px] font-semibold text-neutral-500">{running ? "listening" : "idle"}</span>
          </span>
        </div>

        <div className="mt-2.5 grid grid-cols-5 gap-1">
          {DURATIONS.map((d) => (
            <button
              key={d.label}
              onClick={() => onRun(d.minutes)}
              disabled={running}
              className={`rounded-lg px-1.5 py-1.5 text-[11.5px] font-semibold transition-colors disabled:opacity-40 ${
                minutes === d.minutes && running
                  ? "bg-neutral-900 text-white"
                  : "bg-neutral-100 text-neutral-600 enabled:hover:bg-neutral-200"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>

        <p className="mt-2 text-[11.5px] leading-snug text-neutral-500">
          Real audio · transcribed and judged by mimo-v2.5. Nothing here is scripted.
        </p>

        {running ? (
          <>
            <div className="mt-2.5 flex items-baseline justify-between text-[11px] font-semibold text-neutral-400">
              <span>{progress ? `chunk ${progress.done} of ${progress.total}` : "starting…"}</span>
              <span className="tabular-nums">{pct}%</span>
            </div>
            <div className="mt-1 h-1 rounded-full bg-neutral-100">
              <span className="block h-1 rounded-full bg-neutral-800 transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
            <button
              onClick={onStop}
              className="mt-2 w-full rounded-lg bg-neutral-100 px-3 py-1.5 text-[12px] font-semibold text-neutral-600 hover:bg-neutral-200"
            >
              Stop
            </button>
          </>
        ) : null}

        {error ? (
          <p className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-[11.5px] leading-snug text-red-700">{error}</p>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {!segments.length ? (
          <p className="text-[12.5px] leading-snug text-neutral-400">
            Pick a duration to transcribe that much of the audio and watch the canvas build from it.
            First cards land about 15 seconds in, whichever length you choose.
          </p>
        ) : null}

        {segments.map((s, i) => (
          <div key={i} className="[animation:nodeIn_var(--dur-3)_var(--ease-out)_both]">
            <div className="tabular-nums mb-1 text-[11px] font-bold text-neutral-400">{s.at}</div>
            {s.lines.map((l, j) => (
              <p key={j} className="mb-1 text-[12.5px] leading-snug text-neutral-600">{l}</p>
            ))}

            {s.actions.length ? (
              <div className="mt-1.5 space-y-1 border-l-2 border-neutral-200 pl-2.5">
                {s.actions.map((a, j) => <ActionRow key={j} a={a} />)}
              </div>
            ) : (
              <p className="mt-1.5 text-[11px] italic text-neutral-300">nothing worth keeping</p>
            )}
            {s.dropped ? (
              <p className="mt-1 text-[11px] text-amber-600">{s.dropped} action(s) rejected by validation</p>
            ) : null}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <footer className="border-t border-neutral-200/80 px-4 py-2.5">
        <p className="text-[11px] leading-snug text-neutral-400">
          Operator view — not part of the screen share. Customers see only the canvas.
        </p>
      </footer>
    </aside>
  );
}

function ActionRow({ a }: { a: Applied }) {
  const tone =
    a.op === "topic" ? "#8a8a86"
    : a.op === "focus" ? "#a3a3a3"
    : a.kind === "decision" ? STATE_COLOR.agreed
    : a.kind === "risk" ? STATE_COLOR.blocked
    : a.kind === "question" ? STATE_COLOR.open
    : STATE_COLOR.proposed;

  const text =
    a.op === "topic" ? `▣ Topic · ${a.label}`
    : a.op === "card" ? `＋ ${a.kind} · ${a.label}`
    : a.op === "focus" ? `◎ Camera → ${a.label}`
    : a.op === "state" ? `● Marked ${a.label}`
    : a.op === "react" ? `☺ Reaction`
    : `↔ ${a.op}`;

  return (
    <div className="flex items-center gap-1.5">
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: tone }} />
      <span className="truncate text-[11.5px] font-medium text-neutral-500">{text}</span>
    </div>
  );
}
