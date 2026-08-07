"use client";
// The operator panel: transcript stream on the left of it, Minami's canvas actions inline.
//
// This is NOT part of the screen share. Recall streams /canvas; this panel only exists at
// /canvas?play=… so you can watch the choreography while designing it. Keeping it in the same route
// rather than a separate tool is deliberate — the whole point is seeing a line arrive and the map
// react to it in the same glance, which two windows can't give you.
//
// Actions render inline under the line that caused them, not in a separate log. A log answers "what
// happened"; inline answers "why", and why is the thing you are actually judging: did Minami keep
// the right line, and did she move the camera at the right moment.
import { useEffect, useRef } from "react";
import type { Action, DemoScript } from "@/lib/canvas-demos";
import { KIND_LABEL, STATE_COLOR } from "@/lib/canvas-graph";

export type Spoken = { who: string; say: string; does?: Action[] };

export function TranscriptPanel({
  script, spoken, playing, step, total, nextLine, nextWho,
  onToggle, onNext, onBack, onRestart, onPick,
}: {
  script: DemoScript;
  spoken: Spoken[];
  playing: boolean;
  step: number;
  total: number;
  nextLine?: string;
  nextWho?: string;
  onToggle: () => void;
  onNext: () => void;
  onBack: () => void;
  onRestart: () => void;
  onPick: (id: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  // Follow the stream. A transcript that doesn't autoscroll is a transcript you have to babysit.
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [spoken.length]);

  return (
    <aside className="flex h-dvh w-[380px] shrink-0 flex-col border-l border-neutral-200/80 bg-white/70 backdrop-blur-xl">
      <header className="border-b border-neutral-200/80 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-bold uppercase tracking-[0.13em] text-neutral-400">Transcript</span>
          <span className="ml-auto flex items-center gap-1.5">
            <span
              className="size-1.5 rounded-full"
              style={{ background: playing ? STATE_COLOR.agreed : "#c4c4c0" }}
            />
            <span className="text-[11px] font-semibold text-neutral-500">{playing ? "streaming" : "paused"}</span>
          </span>
        </div>

        <div className="mt-2.5 flex gap-1">
          {["pilot", "investor", "workshop"].map((id) => (
            <button
              key={id}
              onClick={() => onPick(id)}
              className={`flex-1 rounded-lg px-2 py-1.5 text-[11.5px] font-semibold capitalize transition-colors ${
                script.id === id
                  ? "bg-neutral-900 text-white"
                  : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200"
              }`}
            >
              {id}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11.5px] leading-snug text-neutral-500">{script.blurb}</p>

        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            onClick={onBack}
            disabled={step === 0}
            className="rounded-lg bg-neutral-100 px-2.5 py-1.5 text-[12px] font-semibold text-neutral-600 enabled:hover:bg-neutral-200 disabled:opacity-40"
            title="Previous line (←)"
          >
            ←
          </button>
          <button
            onClick={onNext}
            disabled={step >= total}
            className="flex-1 rounded-lg bg-neutral-900 px-3 py-1.5 text-[12px] font-semibold text-white enabled:hover:bg-neutral-800 disabled:opacity-40"
            title="Next line (→)"
          >
            Next line →
          </button>
          <button
            onClick={onToggle}
            disabled={step >= total}
            className="rounded-lg bg-neutral-100 px-2.5 py-1.5 text-[12px] font-semibold text-neutral-600 enabled:hover:bg-neutral-200 disabled:opacity-40"
            title="Auto-play (space)"
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            onClick={onRestart}
            className="rounded-lg bg-neutral-100 px-2.5 py-1.5 text-[12px] font-semibold text-neutral-600 hover:bg-neutral-200"
            title="Back to blank"
          >
            ↺
          </button>
        </div>

        {/* Progress + what's queued. Knowing the NEXT line before you press it is what makes manual
            stepping usable for a demo — you can talk over it instead of reading it cold. */}
        <div className="mt-2.5">
          <div className="flex items-baseline justify-between text-[11px] font-semibold text-neutral-400">
            <span>{step === 0 ? "Blank canvas" : `Line ${step} of ${total}`}</span>
            <span className="tabular-nums">{Math.round((step / Math.max(1, total)) * 100)}%</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-neutral-100">
            <span
              className="block h-1 rounded-full bg-neutral-800 transition-[width] duration-[var(--dur-3)]"
              style={{ width: `${(step / Math.max(1, total)) * 100}%` }}
            />
          </div>
          {nextLine ? (
            <p className="mt-2 line-clamp-2 text-[11.5px] leading-snug text-neutral-400">
              <span className="font-semibold text-neutral-500">Next · {nextWho}:</span> {nextLine}
            </p>
          ) : (
            <p className="mt-2 text-[11.5px] font-semibold text-neutral-400">Meeting complete.</p>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {spoken.length === 0 ? (
          <p className="text-[12.5px] leading-snug text-neutral-400">Blank canvas. Press <span className="font-semibold text-neutral-500">Next line</span> (or →) to advance one line at a time, or ▶ to auto-play.</p>
        ) : null}

        {spoken.map((s, i) => (
          <div key={i} className="[animation:nodeIn_var(--dur-3)_var(--ease-out)_both]">
            <div className="flex items-baseline gap-2">
              <span className="text-[12px] font-bold text-neutral-700">{s.who}</span>
            </div>
            <p className="mt-0.5 text-[13px] leading-snug text-neutral-600">{s.say}</p>

            {s.does?.length ? (
              <div className="mt-1.5 space-y-1 border-l-2 border-neutral-200 pl-2.5">
                {s.does.map((a, j) => <ActionRow key={j} a={a} />)}
              </div>
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

function ActionRow({ a }: { a: Action }) {
  const { text, tone } = describe(a);
  return (
    <div className="flex items-center gap-1.5">
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: tone }} />
      <span className="truncate text-[11.5px] font-medium text-neutral-500">{text}</span>
    </div>
  );
}

/** Plain language, not the action's own vocabulary. "Camera → decision" tells you what to look for
 *  on the map; `{kind:"focus",id:"d1"}` does not. */
function describe(a: Action): { text: string; tone: string } {
  switch (a.kind) {
    case "add":
      return { text: `＋ ${KIND_LABEL[a.node.kind]} · ${a.node.label}`, tone: STATE_COLOR.proposed };
    case "focus":
      return { text: `◎ Camera → ${a.id}`, tone: "#a3a3a3" };
    case "state":
      return { text: `● Marked ${a.state}`, tone: STATE_COLOR[a.state] };
    case "react":
      return { text: `${a.emoji} Reaction added`, tone: STATE_COLOR.open };
    case "collapse":
      return { text: `⊟ Collapsed branch (+${a.count})`, tone: "#a3a3a3" };
    case "celebrate":
      return { text: `✦ ${a.label}`, tone: STATE_COLOR.agreed };
    case "fx":
      return { text: `⌁ ${a.fx === "shake" ? "Flagged" : a.fx === "jump" ? "Pointed at" : "Highlighted"} ${a.id}`, tone: STATE_COLOR.open };
    case "merge":
      return { text: `⇥ Merged ${a.from} → ${a.into}`, tone: STATE_COLOR.agreed };
    case "edge":
      return { text: `↔ ${a.from} ${a.edge} ${a.to}`, tone: STATE_COLOR.blocked };
    case "amend":
      return { text: `✎ Reworded ${a.id}`, tone: STATE_COLOR.proposed };
  }
}
