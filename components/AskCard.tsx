"use client";
// Renders Claude's AskUserQuestion tool as a real choice UI: each question with its options as
// buttons (single- or multi-select), plus a free-text "Other" field. Submitting sends the chosen
// labels back to the live session. Shown in the chat panel while Claude waits on the answer.
import { useState } from "react";
import type { AgentQuestion } from "@/lib/use-agent";

export default function AskCard({ questions, onAnswer }: { questions: AgentQuestion[]; onAnswer: (answers: Record<string, string | string[]>) => void }) {
  // Per-question selection: a Set of chosen labels (single-select keeps at most one). "" key holds "Other" text.
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSel((prev) => {
      const cur = prev[qi] || [];
      if (multi) return { ...prev, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      return { ...prev, [qi]: cur.includes(label) ? [] : [label] };
    });
  };

  const answerFor = (qi: number): string | string[] | null => {
    const q = questions[qi];
    const picks = [...(sel[qi] || [])];
    if (other[qi]?.trim()) picks.push(other[qi].trim()); // free-text "Other" → use the text verbatim
    if (picks.length === 0) return null;
    return q.multiSelect ? picks : picks[0];
  };
  const ready = questions.every((_, qi) => answerFor(qi) !== null);

  const submit = () => {
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q, qi) => { const a = answerFor(qi); if (a !== null) answers[q.question] = a; });
    onAnswer(answers);
  };

  return (
    <div className="mx-4 mb-2 rounded-xl border border-[var(--sakura)]/40 bg-[var(--sakura)]/[0.06] px-3 py-2.5">
      <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--sakura)]"><span>✻</span> Claude is asking</p>
      <div className="space-y-3">
        {questions.map((q, qi) => (
          <div key={qi}>
            <div className="flex items-center gap-1.5">
              {q.header && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-medium text-neutral-300">{q.header}</span>}
              <p className="text-xs font-medium text-neutral-100">{q.question}</p>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {q.options.map((o) => {
                const on = (sel[qi] || []).includes(o.label);
                return (
                  <button key={o.label} onClick={() => toggle(qi, o.label, !!q.multiSelect)} title={o.description}
                    className={`rounded-lg border px-2.5 py-1 text-left text-xs transition-colors ${on ? "border-[var(--sakura)] bg-[var(--sakura)]/20 text-white" : "border-white/15 text-neutral-300 hover:border-white/30 hover:bg-white/5"}`}>
                    <span className="font-medium">{o.label}</span>
                    {o.description && <span className="ml-1 text-[10px] text-neutral-500">· {o.description}</span>}
                  </button>
                );
              })}
            </div>
            <input value={other[qi] || ""} onChange={(e) => setOther((p) => ({ ...p, [qi]: e.target.value }))}
              placeholder="Other…" className="mt-1.5 w-full rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-[var(--sakura)]/60" />
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button onClick={submit} disabled={!ready}
          className="rounded-lg bg-[var(--sakura)] px-3 py-1 text-xs font-medium text-white transition-opacity enabled:hover:opacity-90 disabled:opacity-40">Send answer</button>
        <span className="text-[10px] text-neutral-500">{questions.some((q) => q.multiSelect) ? "pick one or more" : "pick one, or type your own"}</span>
      </div>
    </div>
  );
}
