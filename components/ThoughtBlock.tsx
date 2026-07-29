"use client";
// Claude's reasoning summary in the chat panel. While it's the only thing on screen (a long think
// before any answer) it stays open so you can watch the work happen; once the answer starts it folds
// away behind a disclosure.
//
// A turn's reasoning arrives as several separate passes — one before the first tool call, one after
// each result — which the server marks with a `---` seam (see lib/agent/manager.ts). Splitting on it
// is the whole point: glued end-to-end the passes read as one contradictory paragraph ("I'll check
// X" … "so X was wrong") and you can't see where a tool result changed Claude's mind.
import { useMemo } from "react";
import Markdown from "@/components/Markdown";

const THOUGHT_SEAM = /^-{3,}$/m; // split() ignores the missing /g and cuts at every match
const wordsOf = (s: string) => (s.match(/\S+/g) || []).length;

// The seam between two passes. Numbered rather than a bare rule, so a long think reads as a sequence
// you can navigate instead of an undifferentiated wall.
function PassRule({ n }: { n: number }) {
  return (
    <div className="my-3 flex items-center gap-2" aria-hidden>
      <span className="font-mono text-[9px] tabular-nums text-neutral-600">{String(n).padStart(2, "0")}</span>
      <span className="h-px flex-1 bg-gradient-to-r from-white/[0.09] to-transparent" />
    </div>
  );
}

export default function ThoughtBlock({ text, live }: { text: string; live: boolean }) {
  const passes = useMemo(() => text.split(THOUGHT_SEAM).map((p) => p.trim()).filter(Boolean), [text]);
  // Reasoning is set one step back from the reply: the same markdown parser (so lists and bold
  // lead-ins inside a thought survive as structure) at a smaller, dimmer, upright setting. The old
  // italic-everything treatment was the least readable option available — italics are for emphasis,
  // and a whole block of them is emphasis on nothing.
  const body = (
    <div className="border-l border-[var(--sakura)]/30 pl-3.5 text-[12.5px] text-neutral-500 [overflow-wrap:anywhere]">
      {passes.map((p, i) => (
        <div key={i}>
          {i > 0 && <PassRule n={i + 1} />}
          <Markdown text={p} tone="thought" caret={live && i === passes.length - 1} />
        </div>
      ))}
    </div>
  );
  if (live) return <div className="mb-2">{body}</div>;
  const words = wordsOf(text);
  return (
    <details className="group/think mb-2">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-neutral-600 transition-colors hover:text-neutral-400">
        <span className="inline-block transition-transform group-open/think:rotate-90">›</span>
        thought process
        {/* Collapsed, the only honest signal of what's inside is its size — surface it so a 40-word
            aside and a 900-word deliberation don't present as the same disclosure. */}
        <span className="font-normal normal-case tracking-normal text-neutral-700">
          {passes.length > 1 ? `${passes.length} passes · ` : ""}{words} words
        </span>
      </summary>
      <div className="mt-1.5">{body}</div>
    </details>
  );
}
