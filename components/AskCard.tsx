"use client";
// Renders Claude's AskUserQuestion tool as a wizard: one question at a time, with Next/Back to move
// between them, per-question Skip (leave it unanswered and move on), and a Skip-all escape hatch.
// Submitting sends whichever questions got an answer back to the live session — the AskUserQuestion
// tool's `answers` field is a plain { [question]: label } map, so skipped questions just have no key.
import { useState } from "react";
import type { AgentQuestion } from "@/lib/use-agent";

export default function AskCard({ questions, onAnswer }: { questions: AgentQuestion[]; onAnswer: (answers: Record<string, string | string[]>) => void }) {
  const [qi, setQi] = useState(0);
  // Per-question selection: a Set (well, array) of chosen labels (single-select keeps at most one).
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({}); // free-text "Other" per question
  const [skipped, setSkipped] = useState<Record<number, boolean>>({});

  const n = questions.length;
  const q = questions[qi];
  // Defense in depth alongside the `key={agent.ask.id}` at the call site (app/page.tsx): if `qi` is ever
  // out of range for `questions` (stale index against a newly-swapped prompt), fail quiet instead of
  // throwing on `q.multiSelect` below and crashing the whole page (no error boundary exists upstream).
  if (!q) return null;
  const multi = !!q.multiSelect;
  const isLast = qi === n - 1;

  const toggle = (label: string) => {
    setSkipped((p) => (p[qi] ? { ...p, [qi]: false } : p));
    setSel((prev) => {
      const cur = prev[qi] || [];
      if (multi) return { ...prev, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      return { ...prev, [qi]: cur.includes(label) ? [] : [label] };
    });
  };

  // Reads live sel/other/skipped state — only safe to call when nothing in this render is about to
  // change those for `i` (see skipOne(), which special-cases its own index instead of calling this).
  const answerFor = (i: number): string | string[] | null => {
    if (skipped[i]) return null;
    const picks = [...(sel[i] || [])];
    if (other[i]?.trim()) picks.push(other[i].trim());
    if (picks.length === 0) return null;
    return questions[i].multiSelect ? picks : picks[0];
  };
  const answered = answerFor(qi) !== null;

  const buildAnswers = (skipQi?: number): Record<string, string | string[]> => {
    const answers: Record<string, string | string[]> = {};
    questions.forEach((qq, i) => {
      if (i === skipQi) return;
      const a = answerFor(i);
      if (a !== null) answers[qq.question] = a;
    });
    return answers;
  };

  const finish = () => onAnswer(buildAnswers());
  const next = () => (isLast ? finish() : setQi((i) => i + 1));
  const back = () => setQi((i) => Math.max(0, i - 1));
  // Skip just this question. Build answers with qi explicitly excluded rather than waiting on the
  // setSkipped/setSel state updates above to land — React batches those, so a naive read of `skipped`
  // right after calling setSkipped would still see the stale value on the very last question.
  const skipOne = () => {
    setSkipped((p) => ({ ...p, [qi]: true }));
    setSel((p) => ({ ...p, [qi]: [] }));
    setOther((p) => ({ ...p, [qi]: "" }));
    if (isLast) onAnswer(buildAnswers(qi));
    else setQi((i) => i + 1);
  };
  const skipAll = () => onAnswer({});

  return (
    <div className="mx-4 mb-2 rounded-xl border border-[var(--sakura)]/40 bg-[var(--sakura)]/[0.06] px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--sakura)]"><span>✻</span> Claude is asking</p>
        {n > 1 && (
          <div className="flex items-center gap-1" title={`Question ${qi + 1} of ${n}`}>
            {questions.map((_, i) => (
              <button key={i} onClick={() => setQi(i)}
                className="h-1.5 w-1.5 rounded-full transition-all"
                style={{
                  background: i === qi ? "var(--sakura)" : skipped[i] ? "rgba(255,255,255,0.25)" : answerFor(i) !== null ? "rgba(232,133,155,0.55)" : "rgba(255,255,255,0.15)",
                  transform: i === qi ? "scale(1.4)" : undefined,
                }} />
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-1.5">
          {q.header && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-medium text-neutral-300">{q.header}</span>}
          <p className="min-w-0 flex-1 text-xs font-medium text-neutral-100">{q.question}</p>
          {n > 1 && <span className="shrink-0 text-[10px] tabular-nums text-neutral-500">{qi + 1}/{n}</span>}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {q.options.map((o) => {
            const on = (sel[qi] || []).includes(o.label);
            return (
              <button key={o.label} onClick={() => toggle(o.label)} title={o.description}
                className={`rounded-lg border px-2.5 py-1 text-left text-xs transition-colors ${on ? "border-[var(--sakura)] bg-[var(--sakura)]/20 text-white" : "border-white/15 text-neutral-300 hover:border-white/30 hover:bg-white/5"}`}>
                <span className="font-medium">{o.label}</span>
                {o.description && <span className="ml-1 text-[10px] text-neutral-500">· {o.description}</span>}
              </button>
            );
          })}
        </div>
        <input value={other[qi] || ""} onChange={(e) => { setOther((p) => ({ ...p, [qi]: e.target.value })); setSkipped((p) => (p[qi] ? { ...p, [qi]: false } : p)); }}
          placeholder="Other…" className="mt-1.5 w-full rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-[var(--sakura)]/60" />
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {qi > 0 && <button onClick={back} className="rounded-lg border border-white/15 px-2.5 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/10">← Back</button>}
        <button onClick={next} disabled={!answered}
          className="rounded-lg bg-[var(--sakura)] px-3 py-1 text-xs font-medium text-white transition-opacity enabled:hover:opacity-90 disabled:opacity-40">
          {isLast ? "Send answer" : "Next →"}
        </button>
        <button onClick={skipOne} className="text-[11px] text-neutral-500 transition-colors hover:text-neutral-300 hover:underline">
          Skip{isLast && n > 1 ? " & send" : ""}
        </button>
        <span className="ml-auto text-[10px] text-neutral-600">{multi ? "pick one or more" : "pick one, or type your own"}</span>
      </div>
      {n > 1 && <button onClick={skipAll} className="mt-1.5 text-[10px] text-neutral-600 transition-colors hover:text-neutral-400">Skip all {n} questions</button>}
    </div>
  );
}
