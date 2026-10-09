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
// 6. **A question you cannot answer is still answerable — by handing it to someone who can.** Each
//    question gets a "Not mine →" row of teammates (team-ask's roster; absent if it isn't installed).
//    Picking one answers THAT question with an instruction for Claude to ask that person over Slack
//    via the `ask_team` tool, so a card can be part answered here and part handed over. Before this,
//    a question only the CTO could settle left three bad options: guess, skip it (Claude guesses), or
//    leave the session parked at `phase=awaiting` — which is busy forever and starves every deploy.
// 5. **A preview is shown where its option is.** The tool schema lets the model attach `preview` to an
//    option — the mockup/snippet/plan that the description can only gesture at. This card dropped it
//    silently, so a question written to be decided by comparing two previews arrived as two one-line
//    descriptions and the reason to prefer either was invisible. It renders INSIDE the option row, in
//    the one scrolling region, because that is the only place a block of arbitrary length cannot push
//    "Send answer" off the bottom of a short pane (see the layout note below — that bug is why this
//    card is a flex column at all).
import { useEffect, useRef, useState } from "react";
import type { AgentQuestion } from "@/lib/use-agent";
import { atLeast, useDensityTier } from "@/lib/density";
import { forwardInstruction, type TeamMember } from "@/lib/team-forward";

// Two type scales, and the reason there are two at all.
//
// The card used to sit on the same 9–12px scale as the pane's chrome — a status line's sizes, applied
// to the one place in the UI where the user is READING in order to decide. Thomas's report was simply
// "things look small", and he was right: the question itself was 12px and the option descriptions,
// which are usually where the actual trade-off is written, were 10px grey-on-dark.
//
// So the card gets a reading scale. But it renders outside the transcript, as a sibling of the
// composer, in a pane that CLIPS rather than scrolls (see the layout note below) — and in a four-pane
// grid a pane is ~490px tall. Bigger type there costs option rows the user then can't reach. Hence
// the tier: the reading scale whenever the pane has room, and a compact one (still a step up from
// before) when it is genuinely cramped. Sizes are px, not Tailwind's step ladder, because the ladder's
// gaps (12 → 14 → 16) are too coarse for a card that has to fit four rows and a button in 490px.
const SCALE = {
  reading: { eyebrow: "text-[10.5px]", header: "text-[11px]", question: "text-[15px] leading-snug", hint: "text-[12px]", label: "text-[13.5px]", desc: "text-[12px] leading-relaxed", input: "text-[13.5px]", button: "text-[13px]", skip: "text-[12px]", sending: "text-[11px]", preview: "text-[11.5px]", chip: "text-[11.5px]", mark: "h-4 w-4 text-[10px]", rowPad: "px-3 py-2" },
  compact: { eyebrow: "text-[10px]", header: "text-[10px]", question: "text-[13.5px] leading-snug", hint: "text-[11px]", label: "text-[12.5px]", desc: "text-[11px] leading-snug", input: "text-[12.5px]", button: "text-xs", skip: "text-[11px]", sending: "text-[10px]", preview: "text-[10.5px]", chip: "text-[10.5px]", mark: "h-3.5 w-3.5 text-[9px]", rowPad: "px-2.5 py-1.5" },
} as const;
type Scale = (typeof SCALE)[keyof typeof SCALE];

// Sentinel that lets the free-text row live in the same selection array as the real options, so
// single/multi-select semantics are written once and can't drift between the two. The leading NUL is
// what makes it un-collidable with any label a model could actually send.
// Written as the ESCAPE, never as a literal NUL byte: a raw 0x00 makes git classify this .tsx as
// binary, so every diff of the file reads "Binary files differ" — which is how it sat for a while,
// unreviewable. Identical string at runtime, plain text on disk.
const OTHER = "\u0000other";

export default function AskCard({ questions, onAnswer }: { questions: AgentQuestion[]; onAnswer: (answers: Record<string, string | string[]>) => Promise<string | null> | void }) {
  const d = useDensityTier();
  const sc: Scale = atLeast(d, "snug") ? SCALE.reading : SCALE.compact;
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
  // Per question: the teammate it is being handed to, if any. Mutually exclusive with picking an
  // option — you are either answering it or saying it isn't yours.
  const [fwd, setFwd] = useState<Record<number, TeamMember>>({});
  const [team, setTeam] = useState<TeamMember[]>([]);
  const otherRef = useRef<HTMLInputElement>(null);
  // Tap guards — the reasoning is at "Taps that land somewhere else" below. Hooks, so above the early return.
  const SETTLE_MS = 700;
  const settledAt = useRef(0);
  const unsettle = () => { settledAt.current = Date.now() + SETTLE_MS; };
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    vv?.addEventListener("resize", unsettle);
    window.addEventListener("resize", unsettle);
    return () => { vv?.removeEventListener("resize", unsettle); window.removeEventListener("resize", unsettle); };
  }, []);
  const settled = () => Date.now() >= settledAt.current;
  const [armed, setArmed] = useState<"skipAll" | "empty" | null>(null);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(null), 4000); return () => clearTimeout(t); }, [armed]);
  // A confirm belongs to the question it was armed on.
  useEffect(() => { setArmed(null); }, [qi]);
  // Folded to one line so the transcript gets the pane back. A question is only answerable with the
  // conversation that produced it in view, and the expanded card can't always leave room for that.
  // Lives here, not at the call site, so folding never remounts the card and loses half-made picks.
  const [folded, setFolded] = useState(false);
  // Sending: a click that hasn't been confirmed yet must LOOK different from a dead button. Reported
  // 2026-10-07: Send clicked, nothing happened, no warning, and the answer went through minutes later.
  // So: the button says "Sending…" and locks (a second click can't double-send), after SLOW_MS it says
  // the server is slow, and a failure is said here on the card, where the eyes are.
  const [sending, setSending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  // A ref, not `sending`: two Enters (key repeat, or Enter + click) inside one render both read the
  // stale state and both POST — the second lands "already settled" as an error on the card.
  const sendingRef = useRef(false);
  const deliver = async (answers: Record<string, string | string[]>) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true); setSlow(false); setSendErr(null);
    const t = setTimeout(() => setSlow(true), 5000);
    try {
      const err = await onAnswer(answers);
      // On success the pane drops the ask and this card unmounts; nothing else to do.
      if (err) setSendErr(err);
    } finally {
      clearTimeout(t);
      sendingRef.current = false; setSending(false); setSlow(false);
    }
  };

  // team-ask's roster. A machine without it gets [] and no forward row — same card as before.
  useEffect(() => {
    let alive = true;
    fetch("/api/team/roster")
      .then((r) => r.json())
      .then((d) => { if (alive && Array.isArray(d?.members)) setTeam(d.members); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // With the keyboard up the options scroller shrinks and the field was left out of sight — focused,
  // typed into, invisible. preventScroll stops the browser scrolling the clipped ANCESTORS (which is
  // what made the pane jump); the nearest-scroll then brings it into view inside its own list, and
  // again once the keyboard has finished resizing the viewport.
  const focusOther = () => {
    const el = otherRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
    setTimeout(() => el.scrollIntoView({ block: "nearest" }), 350);
  };

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
    setFwd((p) => (p[qi] ? { ...p, [qi]: undefined as unknown as TeamMember } : p));
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
    if (label === OTHER && (hasText || !picked.includes(OTHER))) focusOther();
  };

  // Typing IS choosing. Without this the text sat there looking accepted while a chip quietly outranked
  // it; now the selection visibly moves to the Other row as the first character lands (and in
  // single-select the previously chosen option visibly clears, which is the honest thing to show).
  const typeOther = (v: string) => {
    setOther((p) => ({ ...p, [qi]: v }));
    setSkipped((p) => (p[qi] ? { ...p, [qi]: false } : p));
    if (v.trim()) setFwd((p) => (p[qi] ? { ...p, [qi]: undefined as unknown as TeamMember } : p));
    setSel((prev) => {
      const cur = prev[qi] || [];
      if (!v.trim()) return cur.includes(OTHER) ? { ...prev, [qi]: cur.filter((l) => l !== OTHER) } : prev;
      if (cur.includes(OTHER)) return prev;
      return { ...prev, [qi]: multi ? [...cur, OTHER] : [OTHER] };
    });
  };

  // Reads live sel/other/skipped state — only safe to call when nothing in this render is about to
  // change those for `i` (see skipOne(), which special-cases its own index instead of calling this).
  // How many questions are being handed over — the instruction says so, so Claude batches the ones
  // going to the same person into a single ask_team call instead of one card per question.
  const fwdCount = Object.values(fwd).filter(Boolean).length;

  const answerFor = (i: number): string | string[] | null => {
    if (skipped[i]) return null;
    const to = fwd[i];
    if (to) return forwardInstruction(to, fwdCount);
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

  const finish = () => deliver(buildAnswers());
  const next = () => (isLast ? finish() : setQi((i) => i + 1));
  const back = () => setQi((i) => Math.max(0, i - 1));
  // Skip just this question. Build answers with qi explicitly excluded rather than waiting on the
  // setSkipped/setSel state updates above to land — React batches those, so a naive read of `skipped`
  // right after calling setSkipped would still see the stale value on the very last question.
  const skipOne = () => {
    setSkipped((p) => ({ ...p, [qi]: true }));
    setSel((p) => ({ ...p, [qi]: [] }));
    setOther((p) => ({ ...p, [qi]: "" }));
    if (otherRef.current) otherRef.current.value = ""; // the field is uncontrolled — clear the DOM too
    setFwd((p) => ({ ...p, [qi]: undefined as unknown as TeamMember }));
    if (isLast) deliver(buildAnswers(qi));
    else setQi((i) => i + 1);
  };
  const skipAll = () => deliver({});

  // ── Taps that land somewhere else (2026-10-07) ─────────────────────────────────────────────────────
  // "Tapped Other, the panel flashed, and Claude asked again." The question had come back as "The user
  // did not answer the questions" — an EMPTY answer, which only Skip / Skip all send. On a phone, the
  // tap that leaves the Other field closes the keyboard; the pane reflows under the finger; and the
  // click lands on whatever is there now — Skip sits beside Next, Skip all just below. Emulated touch
  // showed the half of it a script can see: the first tap on Next after typing didn't register.
  // Three guards: Next/Send keep the field focused (pointerdown preventDefault), so nothing moves;
  // a Skip within SETTLE_MS of the keyboard closing or the layout resizing is ignored; and anything
  // that would send NO answer at all takes a second tap.
  // (SETTLE_MS, settledAt, armed: declared at the top with the other hooks — see "Taps that land".)
  const guardedSkipOne = () => {
    if (!settled()) return;
    // Skipping the last question when nothing else was answered sends an empty answer: confirm it.
    if (isLast && Object.keys(buildAnswers(qi)).length === 0 && armed !== "empty") { setArmed("empty"); return; }
    setArmed(null); skipOne();
  };
  const guardedSkipAll = () => {
    if (!settled()) return;
    if (armed !== "skipAll") { setArmed("skipAll"); return; }
    setArmed(null); skipAll();
  };
  const keepFocus = (e: React.PointerEvent) => { if (document.activeElement === otherRef.current) e.preventDefault(); };

  const count = answerFor(qi);
  const nPicked = Array.isArray(count) ? count.length : count ? 1 : 0;

  if (folded) return (
    <div className="mx-4 mb-2 flex shrink-0 items-center gap-2 rounded-xl border border-[var(--sakura)]/40 bg-[var(--sakura)]/[0.06] px-3 py-2">
      <span className={`shrink-0 ${sc.eyebrow} font-medium uppercase tracking-wider text-[var(--sakura)]`}>✻ Asking</span>
      <span className={`min-w-0 flex-1 truncate ${sc.hint} text-neutral-300`} title={q.question}>{q.question}</span>
      {n > 1 && <span className={`shrink-0 ${sc.hint} tabular-nums text-neutral-500`}>{qi + 1}/{n}</span>}
      <button onClick={() => setFolded(false)}
        className={`shrink-0 rounded-lg bg-[var(--sakura)] px-3 py-1 ${sc.button} font-medium text-white transition-opacity hover:opacity-90`}>
        Answer ▴
      </button>
    </div>
  );

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
    //
    // `max-h-[60%]` is the other half: shrinking alone let the card take every pixel it wanted, and
    // the transcript (flex-basis 0) gave them all up — a four-option question left the log at zero
    // height, so the context the question was about was exactly what you couldn't scroll back to.
    // The cap keeps 40% of the pane for the conversation; the fold button gives it all of it.
    <div className="mx-4 mb-2 flex max-h-[60%] min-h-0 flex-col focus-within:max-h-[88%] rounded-xl border border-[var(--sakura)]/40 bg-[var(--sakura)]/[0.06] px-3 py-2.5">
      <div className="mb-1.5 flex shrink-0 items-center justify-between gap-2">
        <p className={`flex items-center gap-1.5 ${sc.eyebrow} font-medium uppercase tracking-wider text-[var(--sakura)]`}><span>✻</span> Claude is asking</p>
        {n > 1 && (
          <div className="ml-auto flex items-center gap-1" title={`Question ${qi + 1} of ${n}`}>
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
        {/* After the dots and set off by a rule: beside them it read as a label for the step dots. */}
        <button onClick={() => setFolded(true)} title="Fold this card to read the conversation above it — your picks are kept"
          className={`${n > 1 ? "" : "ml-auto "}border-l border-white/10 pl-2.5 pointer-coarse:min-h-10 ${sc.hint} text-neutral-500 transition-colors hover:text-neutral-200`}>
          ▾ read the chat
        </button>
      </div>

      {/* Question + the select-one/all hint: pinned. Scrolling the thing being asked out of view while
          you choose is how you answer the wrong question. */}
      <div className="shrink-0">
        {/* Header pill above the question rather than beside it: a 15px question next to a pill wraps
            the pill onto its own line anyway once the question is more than a few words, and then the
            two compete for the first line. Stacked, the pill reads as the topic and the question as
            the question. */}
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {q.header && <span className={`mb-1 inline-block rounded bg-white/10 px-1.5 py-0.5 ${sc.header} font-medium text-neutral-300`}>{q.header}</span>}
            <p className={`${sc.question} font-medium text-neutral-50`}>{q.question}</p>
          </div>
          {n > 1 && <span className={`shrink-0 pt-0.5 ${sc.hint} tabular-nums text-neutral-500`}>{qi + 1}/{n}</span>}
        </div>

        {/* Said in words, right under the question, because the shape of a control is only obvious
            once you already know the convention. Multi-select gets the louder treatment — it's the
            one that's invisible if you assume every question is a radio group. */}
        <p className={`mt-1.5 flex flex-wrap items-center gap-1 ${sc.hint} ${multi ? "font-medium text-[var(--sakura)]" : "text-neutral-500"}`}>
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
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5">
        {q.options.map((o) => {
          const on = picked.includes(o.label);
          const k = `${qi}:${o.label}`;
          return <Row key={o.label} sc={sc} multi={multi} on={on} onClick={() => toggle(o.label)} label={o.label} description={o.description}
            preview={o.preview} previewOpen={open[k] ?? on} onTogglePreview={() => setOpen((p) => ({ ...p, [k]: !(p[k] ?? on) }))} />;
        })}

        {/* "Other" is the last row of the same list, not a stray input below it — so exactly one
            thing is ever highlighted, and what's highlighted is what gets sent. */}
        <Row sc={sc} multi={multi} on={picked.includes(OTHER)} onClick={() => toggle(OTHER)} label="Other"
          description={picked.includes(OTHER) ? undefined : "type your own answer"}>
          {/* UNCONTROLLED, keyed by question (2026-10-09). "Everything I type got mirrored from right to
              left" on the phone: typing came out reversed or right-to-left. A controlled input lets React
              write `value` back into the field, and an Android keyboard that is composing a word reads any
              write as a caret move to the start, so every letter landed in front of the last. It didn't
              reproduce in emulation (WebKit, Chromium + IME composition), so this removes the mechanism:
              React never writes the field while you type; `defaultValue` + `key={qi}` restore a
              question's text when you page back, and `dir="ltr"` pins the direction. `other` stays the
              source of truth for the answer. */}
          <input key={qi} ref={otherRef} defaultValue={other[qi] || ""} onChange={(e) => typeOther(e.target.value)}
            dir="ltr" autoCapitalize="sentences" autoCorrect="on" spellCheck

            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && answered) next(); }}
            placeholder="type your own answer…"
            className={`mt-1.5 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 pointer-coarse:py-2.5 ${sc.input} text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-[var(--sakura)]/60`} />
        </Row>
      </div>

      {/* Hand this one question to someone else. Inside the scrolling region deliberately: it is part
          of choosing an answer, not an action on the card, and it must never push Send off the pane. */}
      {team.length > 0 && (
        <div className={`mt-2 flex shrink-0 flex-wrap items-center gap-1.5 ${sc.chip}`}>
          <span className="text-neutral-400">Not mine — ask:</span>
          {team.map((m) => {
            const on = fwd[qi]?.key === m.key;
            return (
              <button key={m.key} title={m.role || m.expertise?.join(", ")}
                onClick={() => setFwd((p) => ({ ...p, [qi]: on ? (undefined as unknown as TeamMember) : m }))}
                className={`rounded-full border px-2 py-0.5 transition-colors pointer-coarse:min-h-10 pointer-coarse:px-3 ${
                  on ? "border-[var(--sakura)] bg-[var(--sakura)]/20 text-white"
                     : "border-white/15 text-neutral-400 hover:border-white/30 hover:text-neutral-200"}`}>
                {on ? "✓ " : ""}{m.name}
              </button>
            );
          })}
          {fwd[qi] && <span className="basis-full text-[var(--sakura)]">→ On send, Claude asks {fwd[qi].name} on Slack and waits; the wait shows here as a card.</span>}
        </div>
      )}

      {/* Pinned. This row is the exit from `phase=awaiting`; it may never be the thing that overflows. */}
      <div className="mt-2.5 flex shrink-0 flex-wrap items-center gap-2">
        {qi > 0 && <button onClick={back} className={`rounded-lg border border-white/15 px-3 py-1.5 pointer-coarse:min-h-11 ${sc.button} text-neutral-300 transition-colors hover:bg-white/10`}>← Back</button>}
        <button onClick={next} onPointerDown={keepFocus} disabled={!answered || sending}
          className={`rounded-lg bg-[var(--sakura)] px-3.5 py-1.5 pointer-coarse:min-h-11 pointer-coarse:px-5 ${sc.button} font-medium text-white transition-opacity enabled:hover:opacity-90 disabled:opacity-40 ${sending ? "animate-pulse" : ""}`}>
          {sending ? "Sending…" : isLast ? "Send answer" : "Next →"}
        </button>
        <button onClick={guardedSkipOne} disabled={sending} className={`pointer-coarse:min-h-11 pointer-coarse:px-2 ${sc.skip} ${armed === "empty" ? "font-medium text-[#f0a868]" : "text-neutral-500"} transition-colors hover:text-neutral-300 hover:underline disabled:opacity-40`}>
          {armed === "empty" && isLast ? "Send with no answer? Tap again" : `Skip${isLast && n > 1 ? " & send" : ""}`}
        </button>
        {/* What will actually be sent, in the words that will be sent. The old hint described the
            *rules* of the control; this describes the outcome, which is the thing in doubt. */}
        <span className={`ml-auto min-w-0 truncate ${sc.sending} text-neutral-500`} title={fwd[qi] ? `${fwd[qi].name}${fwd[qi].role ? ` — ${fwd[qi].role}` : ""}` : answered ? String(Array.isArray(count) ? count.join(", ") : count) : undefined}>
          {fwd[qi]
            ? <>handing to <span className="text-neutral-300">{fwd[qi].name}</span></>
            : answered
              ? <>sending: <span className="text-neutral-300">{Array.isArray(count) ? count.join(", ") : count}</span></>
              : "nothing selected yet"}
        </span>
      </div>
      {(slow || sendErr) && (
        <p role="status" className={`mt-1.5 shrink-0 ${sc.hint} ${sendErr ? "text-[#ef7c7c]" : "text-[#f0a868]"}`}>
          {sendErr ? `Didn't go through — ${sendErr}. Tap Send again.` : "Still sending — the server is slow right now. Your answer is on its way; no need to click again."}
        </p>
      )}
      {n > 1 && <button onClick={guardedSkipAll} disabled={sending} className={`mt-1.5 shrink-0 self-start pointer-coarse:min-h-11 ${sc.skip} ${armed === "skipAll" ? "font-medium text-[#f0a868]" : "text-neutral-600"} transition-colors hover:text-neutral-400 disabled:opacity-40`}>{armed === "skipAll" ? `Skip all ${n}? Claude gets no answers — tap again` : `Skip all ${n} questions`}</button>}
    </div>
  );
}

// One option, full width. The marker is the affordance: a circle fills for single-select, a box gets a
// tick for multi — so "can I pick more than one?" is answered before you click anything.
function Row({ sc, multi, on, onClick, label, description, preview, previewOpen, onTogglePreview, children }: {
  sc: Scale; multi: boolean; on: boolean; onClick: () => void; label: string; description?: string;
  preview?: string; previewOpen?: boolean; onTogglePreview?: () => void; children?: React.ReactNode;
}) {
  return (
    <div onClick={onClick} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      className={`w-full cursor-pointer rounded-lg border ${sc.rowPad} text-left transition-colors ${
        on ? "border-[var(--sakura)] bg-[var(--sakura)]/20" : "border-white/15 hover:border-white/30 hover:bg-white/5"}`}>
      <div className="flex items-start gap-2">
        <span className={`mt-[3px] flex ${sc.mark} shrink-0 items-center justify-center border leading-none ${
          multi ? "rounded-[4px]" : "rounded-full"} ${
          on ? "border-[var(--sakura)] bg-[var(--sakura)] text-white" : "border-white/30"}`}>
          {on && (multi ? "✓" : <span className="h-1.5 w-1.5 rounded-full bg-white" />)}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block ${sc.label} font-medium ${on ? "text-white" : "text-neutral-200"}`}>{label}</span>
          {/* neutral-400, not 500: the description is usually where the trade-off is actually written,
              and 10px neutral-500 on this ground measured as the least legible text in the app. */}
          {description && <span className={`mt-0.5 block ${sc.desc} text-neutral-400`}>{description}</span>}
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
                className={`mt-1 ${sc.hint} text-neutral-500 transition-colors hover:text-[var(--sakura)]`}>
                {previewOpen ? "⌄ hide preview" : "› preview"}
              </button>
              {previewOpen && (
                // Clicks land on the text, not the row: a preview is there to be read and copied, and
                // dragging to select it must not re-toggle the answer underneath.
                <span onClick={(e) => e.stopPropagation()}
                  className={`mt-1 block max-h-48 cursor-text overflow-auto whitespace-pre-wrap break-words rounded-md border border-white/10 bg-black/40 px-2.5 py-2 font-mono ${sc.preview} leading-relaxed text-neutral-300`}>
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
