"use client";
// Renders Claude's AskUserQuestion tool as a wizard: one question at a time, with Next/Back to move
// between them, per-question Skip (leave it unanswered and move on), and a Skip-all escape hatch.
// Submitting sends whichever questions got an answer back to the live session — the AskUserQuestion
// tool's `answers` field is a plain { [question]: label } map, so skipped questions just have no key.
//
// ── Three rules this card exists to obey ─────────────────────────────────────────────────────────
// 1. **"Other" is an option, not a side channel.** It sits in the list, it selects like any other row,
//    and typing in it selects it. Before, the free text and the chips were independent state that both
//    lit up — and single-select silently sent the CHIP and threw the typed text away. You cannot tell
//    a form what you meant if it shows two answers as equally chosen and picks one behind your back.
// 2. **The control's shape says how many you may pick.** Radios for one, checkboxes for many, stated
//    in words next to the question too. "It was multi-select and I had no way to know" is a UI bug,
//    not a user error.
// 3. **One option per row, always.** Wrapped chips put option 3 above option 2 at some widths, which
//    turns a list you scan into a puzzle you solve.
// 4. **The Other row follows its text.** Text in the field means the row is part of the answer, and no
//    click can withdraw it — only clearing the field can. Selection and free text are one state, so
//    there is no gesture that leaves a typed answer on screen that Send won't send.
// 5. **A preview is shown where its option is.** The tool schema lets the model attach `preview` to an
//    option — the mockup/snippet/plan that the description can only gesture at. This card dropped it
//    silently, so a question written to be decided by comparing two previews arrived as two one-line
//    descriptions and the reason to prefer either was invisible. It renders INSIDE the option row, in
//    the one scrolling region, because that is the only place a block of arbitrary length cannot push
//    "Send answer" off the bottom of a short pane (see the layout note below — that bug is why this
//    card is a flex column at all).
import { useRef, useState } from "react";
import type { AgentQuestion } from "@/lib/use-agent";

// Sentinel that lets the free-text row live in the same selection array as the real options, so
// single/multi-select semantics are written once and can't drift between the two. The leading NUL is
// what makes it un-collidable with any label a model could actually send.
// Written as the ESCAPE, never as a literal NUL byte: a raw 0x00 makes git classify this .tsx as
// binary, so every diff of the file reads "Binary files differ" — which is how it sat for a while,
// unreviewable. Identical string at runtime, plain text on disk.
const OTHER = "\u0000other";

export default function AskCard({ questions, onAnswer }: { questions: AgentQuestion[]; onAnswer: (answers: Record<string, string | string[]>) => void }) {
  const [qi, setQi] = useState(0);
  // Per-question selection: a Set (well, array) of chosen labels (single-select keeps at most one).
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({}); // free-text "Other" per question
  const [skipped, setSkipped] = useState<Record<number, boolean>>({});
  // Explicit preview open/close, keyed `${questionIndex}:${label}`. Absent means "follow the selection"
  // — the schema calls preview "rendered when this option is focused", and selecting is what focus
  // means with a mouse. So choosing an option shows you what you chose, and an explicit toggle still
  // wins in both directions (peek at one you haven't picked; collapse one you have).
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const otherRef = useRef<HTMLInputElement>(null);

  const n = questions.length;
  const q = questions[qi];
  // Defense in depth alongside the `key={agent.ask.id}` at the call site (app/page.tsx): if `qi` is ever
  // out of range for `questions` (stale index against a newly-swapped prompt), fail quiet instead of
  // throwing on `q.multiSelect` below and crashing the whole page (no error boundary exists upstream).
  if (!q) return null;
  const multi = !!q.multiSelect;
  const isLast = qi === n - 1;
  const picked = sel[qi] || [];

  const toggle = (label: string) => {
    setSkipped((p) => (p[qi] ? { ...p, [qi]: false } : p));
    // Rule 4: while the Other field holds text, clicking its row SELECTS, never deselects. Typing
    // already selected the row, so the plain toggle read that click as "turn it off" and left the
    // typed answer visible in a field the disabled Send button refused to send — with no clue that
    // the click was what withdrew it. Clicking the row you just typed into is the obvious way to
    // confirm a choice, and the row's padding around the input makes it easy to hit by accident.
    // The text is the answer; clearing the field is how you withdraw it (see typeOther).
    const hasText = label === OTHER && !!(other[qi] || "").trim();
    setSel((prev) => {
      const cur = prev[qi] || [];
      if (hasText) return cur.includes(label) ? prev : { ...prev, [qi]: multi ? [...cur, label] : [label] };
      if (multi) return { ...prev, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      return { ...prev, [qi]: cur.includes(label) ? [] : [label] };
    });
    // Only chase the caret when the row ends up ON. Focusing a row the same click just switched off
    // is what made the old trap read as a UI freeze rather than a deselect.
    if (label === OTHER && (hasText || !picked.includes(OTHER))) otherRef.current?.focus();
  };

  // Typing IS choosing. Without this the text sat there looking accepted while a chip quietly outranked
  // it; now the selection visibly moves to the Other row as the first character lands (and in
  // single-select the previously chosen option visibly clears, which is the honest thing to show).
  const typeOther = (v: string) => {
    setOther((p) => ({ ...p, [qi]: v }));
    setSkipped((p) => (p[qi] ? { ...p, [qi]: false } : p));
    setSel((prev) => {
      const cur = prev[qi] || [];
      if (!v.trim()) return cur.includes(OTHER) ? { ...prev, [qi]: cur.filter((l) => l !== OTHER) } : prev;
      if (cur.includes(OTHER)) return prev;
      return { ...prev, [qi]: multi ? [...cur, OTHER] : [OTHER] };
    });
  };

  // Reads live sel/other/skipped state — only safe to call when nothing in this render is about to
  // change those for `i` (see skipOne(), which special-cases its own index instead of calling this).
  const answerFor = (i: number): string | string[] | null => {
    if (skipped[i]) return null;
    const txt = (other[i] || "").trim();
    // The sentinel resolves to whatever was typed; an empty Other row is not an answer, so it drops
    // out rather than sending "" and making Claude guess what a blank choice meant.
    // De-duped: in multi-select you can tick an option AND type its exact label into Other, and
    // sending ["A","A"] asks Claude to read a repetition as emphasis.
    const picks = [...new Set((sel[i] || []).map((l) => (l === OTHER ? txt : l)).filter(Boolean))];
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

  const count = answerFor(qi);
  const nPicked = Array.isArray(count) ? count.length : count ? 1 : 0;

  return (
    // ── Why this is a flex column that can shrink ──────────────────────────────────────────────────
    // This card renders OUTSIDE the transcript's scroll area, as a sibling of the composer, inside a
    // pane whose root is `flex min-h-0 flex-col overflow-hidden`. So an oversized card is not scrolled,
    // it is CLIPPED — and a flex item's default `min-height:auto` refuses to shrink below its content,
    // which means the overflow lands wherever the content happens to end.
    //
    // In a 4-pane grid a pane is ~490px tall while a 4-option question with descriptions needs 400–500,
    // so "Send answer" fell off the bottom of the pane with nothing to scroll and no way to reach it.
    // That is not cosmetic: an unanswered AskUserQuestion holds the session at `phase=awaiting`, which
    // is busy forever (§8) — it blocks the pane AND starves any deploy waiting for the box to go quiet.
    //
    // `min-h-0` lets the card shrink to whatever the pane can spare; only the OPTIONS scroll, while the
    // question and the action row stay pinned. The two things you must always be able to see are what
    // is being asked and the button that answers it.
    <div className="mx-4 mb-2 flex min-h-0 flex-col rounded-xl border border-[var(--sakura)]/40 bg-[var(--sakura)]/[0.06] px-3 py-2.5">
      <div className="mb-1.5 flex shrink-0 items-center justify-between gap-2">
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

      {/* Question + the select-one/all hint: pinned. Scrolling the thing being asked out of view while
          you choose is how you answer the wrong question. */}
      <div className="shrink-0">
        <div className="flex items-center gap-1.5">
          {q.header && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-medium text-neutral-300">{q.header}</span>}
          <p className="min-w-0 flex-1 text-xs font-medium text-neutral-100">{q.question}</p>
          {n > 1 && <span className="shrink-0 text-[10px] tabular-nums text-neutral-500">{qi + 1}/{n}</span>}
        </div>

        {/* Said in words, right under the question, because the shape of a control is only obvious
            once you already know the convention. Multi-select gets the louder treatment — it's the
            one that's invisible if you assume every question is a radio group. */}
        <p className={`mt-1 flex items-center gap-1 text-[10px] ${multi ? "font-medium text-[var(--sakura)]" : "text-neutral-500"}`}>
          {multi ? <>☑ Select <strong className="font-semibold">all that apply</strong>{nPicked > 0 && <span className="text-neutral-500">· {nPicked} selected</span>}</> : <>◉ Select one</>}
          {/* Said here as well as on the rows: when a question is written to be decided by comparing
              previews, a collapsed row gives no sign that the deciding material is one click away. */}
          {q.options.some((o) => o.preview) && <span className="text-neutral-500">· previews available</span>}
        </p>

      </div>

      {/* The ONLY scrolling region. Strictly one option per row — wrapping chips reorder themselves as
          the pane resizes, so the option you reach for is never in the same place twice.
          Scrollbar deliberately NOT hidden here (it is elsewhere in this app): when the list is taller
          than the pane, that bar is the only thing telling you there are more options below. */}
      <div className="mt-1.5 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-0.5">
        {q.options.map((o) => {
          const on = picked.includes(o.label);
          const k = `${qi}:${o.label}`;
          return <Row key={o.label} multi={multi} on={on} onClick={() => toggle(o.label)} label={o.label} description={o.description}
            preview={o.preview} previewOpen={open[k] ?? on} onTogglePreview={() => setOpen((p) => ({ ...p, [k]: !(p[k] ?? on) }))} />;
        })}

        {/* "Other" is the last row of the same list, not a stray input below it — so exactly one
            thing is ever highlighted, and what's highlighted is what gets sent. */}
        <Row multi={multi} on={picked.includes(OTHER)} onClick={() => toggle(OTHER)} label="Other"
          description={picked.includes(OTHER) ? undefined : "type your own answer"}>
          <input ref={otherRef} value={other[qi] || ""} onChange={(e) => typeOther(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && answered) next(); }}
            placeholder="type your own answer…"
            className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-[var(--sakura)]/60" />
        </Row>
      </div>

      {/* Pinned. This row is the exit from `phase=awaiting`; it may never be the thing that overflows. */}
      <div className="mt-2.5 flex shrink-0 flex-wrap items-center gap-2">
        {qi > 0 && <button onClick={back} className="rounded-lg border border-white/15 px-2.5 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/10">← Back</button>}
        <button onClick={next} disabled={!answered}
          className="rounded-lg bg-[var(--sakura)] px-3 py-1 text-xs font-medium text-white transition-opacity enabled:hover:opacity-90 disabled:opacity-40">
          {isLast ? "Send answer" : "Next →"}
        </button>
        <button onClick={skipOne} className="text-[11px] text-neutral-500 transition-colors hover:text-neutral-300 hover:underline">
          Skip{isLast && n > 1 ? " & send" : ""}
        </button>
        {/* What will actually be sent, in the words that will be sent. The old hint described the
            *rules* of the control; this describes the outcome, which is the thing in doubt. */}
        <span className="ml-auto min-w-0 truncate text-[10px] text-neutral-500" title={answered ? String(Array.isArray(count) ? count.join(", ") : count) : undefined}>
          {answered ? <>sending: <span className="text-neutral-300">{Array.isArray(count) ? count.join(", ") : count}</span></> : "nothing selected yet"}
        </span>
      </div>
      {n > 1 && <button onClick={skipAll} className="mt-1.5 text-[10px] text-neutral-600 transition-colors hover:text-neutral-400">Skip all {n} questions</button>}
    </div>
  );
}

// One option, full width. The marker is the affordance: a circle fills for single-select, a box gets a
// tick for multi — so "can I pick more than one?" is answered before you click anything.
function Row({ multi, on, onClick, label, description, preview, previewOpen, onTogglePreview, children }: {
  multi: boolean; on: boolean; onClick: () => void; label: string; description?: string;
  preview?: string; previewOpen?: boolean; onTogglePreview?: () => void; children?: React.ReactNode;
}) {
  return (
    <div onClick={onClick} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      className={`w-full cursor-pointer rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
        on ? "border-[var(--sakura)] bg-[var(--sakura)]/20" : "border-white/15 hover:border-white/30 hover:bg-white/5"}`}>
      <div className="flex items-start gap-2">
        <span className={`mt-[2px] flex h-3.5 w-3.5 shrink-0 items-center justify-center border text-[9px] leading-none ${
          multi ? "rounded-[4px]" : "rounded-full"} ${
          on ? "border-[var(--sakura)] bg-[var(--sakura)] text-white" : "border-white/30"}`}>
          {on && (multi ? "✓" : <span className="h-1.5 w-1.5 rounded-full bg-white" />)}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-xs font-medium ${on ? "text-white" : "text-neutral-300"}`}>{label}</span>
          {description && <span className="mt-0.5 block text-[10px] leading-snug text-neutral-500">{description}</span>}
          {children}
          {/* Block elements are spelled as `block` spans on purpose: this subtree is inside the row's
              `<span>`, and a real <pre>/<div> there is invalid nesting that React will hydrate into a
              different DOM than it rendered on the server. */}
          {preview && (
            <>
              <button onClick={(e) => { e.stopPropagation(); onTogglePreview?.(); }}
                // The row itself answers Enter/Space by selecting. Without this the same keypress both
                // toggled the preview and picked the option — one key, two decisions.
                onKeyDown={(e) => e.stopPropagation()}
                className="mt-1 text-[10px] text-neutral-500 transition-colors hover:text-[var(--sakura)]">
                {previewOpen ? "⌄ hide preview" : "› preview"}
              </button>
              {previewOpen && (
                // Clicks land on the text, not the row: a preview is there to be read and copied, and
                // dragging to select it must not re-toggle the answer underneath.
                <span onClick={(e) => e.stopPropagation()}
                  className="mt-1 block max-h-40 cursor-text overflow-auto whitespace-pre-wrap break-words rounded-md border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-neutral-400">
                  {preview}
                </span>
              )}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
