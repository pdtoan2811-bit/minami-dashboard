"use client";
// The chat composer — a <textarea> that behaves like Slack's message box instead of a raw one-line input.
//
// Three things it adds over a plain textarea:
//   1. It grows with what you type (up to MAX_H, then scrolls), so a long prompt is visible as you write it.
//   2. It understands list syntax: "1." / "-" / "- [ ]" continue on Shift+Enter, ordered lists renumber
//      themselves, Tab/Shift+Tab nest, and Backspace on an empty marker drops out of the list.
//   3. It *tints* that syntax via a mirror layer painted behind the (transparent) text.
//
// The textarea stays the single source of truth — what Claude receives is still the exact raw markdown
// you typed. The mirror only recolours characters; it never changes a glyph's width, weight or style, so
// the two layers wrap identically and stay pixel-aligned. That constraint is why bold renders as dimmed
// `**` delimiters rather than actual bold: changing font-weight would shift the text off the caret.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

// useLayoutEffect is a no-op (and warns) during Next's server prerender.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const MAX_H = 220; // px — past this the composer scrolls instead of growing

// A list line, split into parts. 1=indent 2=number 3=delimiter 4=bullet 5=gap 6=task box 7=body
const LIST = /^([ \t]*)(?:(\d+)([.)])|([-*+•]))([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/;
const INDENT = "  ";

const lineStartOf = (v: string, pos: number) => v.lastIndexOf("\n", pos - 1) + 1;
const lineEndOf = (v: string, pos: number) => { const i = v.indexOf("\n", pos); return i === -1 ? v.length : i; };

/* ---------------- editing primitives ---------------- */

// Replace [start,end) with `text` through the browser's own edit pipeline, so native undo (⌘Z) keeps
// working and React still sees an input event. Falls back to setRangeText if execCommand is gone.
function replaceRange(el: HTMLTextAreaElement, start: number, end: number, text: string, caret?: number) {
  el.focus();
  el.setSelectionRange(start, end);
  let ok = false;
  try { ok = text === "" && end > start ? document.execCommand("delete") : document.execCommand("insertText", false, text); }
  catch { ok = false; }
  if (!ok) {
    el.setRangeText(text, start, end, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (caret != null) el.setSelectionRange(caret, caret);
}

// Renumber the run of ordered items at the same indent surrounding the caret, so inserting "3." in the
// middle pushes the ones below it down instead of leaving two 3s.
function renumberRun(el: HTMLTextAreaElement) {
  const v = el.value;
  const caret = el.selectionStart;
  const lines = v.split("\n");

  // Which line is the caret on, and where does each line begin?
  const offsets: number[] = [];
  let acc = 0;
  for (const l of lines) { offsets.push(acc); acc += l.length + 1; }
  let idx = lines.length - 1;
  for (let i = 0; i < lines.length; i++) if (caret <= offsets[i] + lines[i].length) { idx = i; break; }

  const cur = LIST.exec(lines[idx]);
  if (!cur || !cur[2]) return; // not an ordered item — nothing to renumber
  const indent = cur[1];
  const sameRun = (s: string) => { const m = LIST.exec(s); return m && m[2] && m[1] === indent ? m : null; };

  let a = idx, b = idx;
  while (a > 0 && sameRun(lines[a - 1])) a--;
  while (b < lines.length - 1 && sameRun(lines[b + 1])) b++;

  const first = Number(LIST.exec(lines[a])![2]);
  const out: string[] = [];
  let changed = false, caretShift = 0;
  for (let i = a; i <= b; i++) {
    const m = LIST.exec(lines[i])!;
    const want = String(first + (i - a));
    if (m[2] !== want) {
      changed = true;
      const delta = want.length - m[2].length;
      // Lines above the caret push it down; a width change on its own line pushes it only if it
      // sits after the number (9. → 10. must not leave the caret inside the marker).
      if (i < idx) caretShift += delta;
      else if (i === idx && caret > offsets[idx] + m[1].length + m[2].length) caretShift += delta;
    }
    out.push(m[1] + want + m[3] + m[5] + (m[6] || "") + m[7]);
  }
  if (!changed) return;

  const start = offsets[a];
  const end = offsets[b] + lines[b].length;
  replaceRange(el, start, end, out.join("\n"), caret + caretShift);
}

/* ---------------- syntax tint (colour only — never metrics) ---------------- */

const DIM = "text-neutral-500";
const ACCENT = "text-[var(--sakura)]";
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\))/g;

function tintInline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, k = 0, m: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const kk = `${key}i${k++}`;
    if (tok.startsWith("`")) {
      out.push(<span key={kk} className="rounded-[3px] bg-white/[0.07] text-[#e8b3c0]">{tok}</span>);
    } else if (tok.startsWith("[")) {
      const cut = tok.indexOf("](");
      out.push(<span key={kk}><span className={DIM}>[</span><span className={ACCENT}>{tok.slice(1, cut)}</span><span className={DIM}>{tok.slice(cut)}</span></span>);
    } else {
      const d = tok.startsWith("~~") ? 2 : tok.startsWith("**") || tok.startsWith("__") ? 2 : 1;
      out.push(<span key={kk}><span className={DIM}>{tok.slice(0, d)}</span><span className="text-white">{tok.slice(d, -d)}</span><span className={DIM}>{tok.slice(-d)}</span></span>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function tintLine(line: string, key: string): ReactNode {
  const list = LIST.exec(line);
  if (list) {
    const [, ind, num, delim, bullet, gap, task, body] = list;
    const done = task ? /x/i.test(task) : false;
    return (
      <>
        {ind}
        <span className={`${ACCENT} font-medium`}>{num ? num + delim : bullet}</span>
        {gap}
        {task && <span className={done ? "text-green-400" : ACCENT}>{task}</span>}
        <span className={done ? "text-neutral-500" : undefined}>{tintInline(body, key)}</span>
      </>
    );
  }
  const head = /^(#{1,6})([ \t]+)(.*)$/.exec(line);
  if (head) return <>{<span className={DIM}>{head[1]}</span>}{head[2]}<span className="text-white">{tintInline(head[3], key)}</span></>;
  const quote = /^([ \t]*)(>)([ \t]*)(.*)$/.exec(line);
  if (quote) return <>{quote[1]}<span className={ACCENT}>{quote[2]}</span>{quote[3]}<span className="text-neutral-300">{tintInline(quote[4], key)}</span></>;
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return <span className={DIM}>{line}</span>;
  return tintInline(line, key);
}

/* ---------------- component ---------------- */

export default function Composer({ value, onChange, onSubmit, placeholder, disabled }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);

  // Grow to fit the content, then scroll. Runs before paint so there's no visible reflow jump.
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const h = Math.min(el.scrollHeight, MAX_H);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? "auto" : "hidden";
    if (mirror.current) mirror.current.scrollTop = el.scrollTop;
  }, [value]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = ref.current;
    if (!el) return;
    // Never steal a key mid-IME — Vietnamese/CJK composition ends with Enter.
    if (e.nativeEvent.isComposing) return;

    const v = el.value;
    const caret = el.selectionStart;
    const ls = lineStartOf(v, caret);
    const le = lineEndOf(v, caret);
    const line = v.slice(ls, le);
    const m = LIST.exec(line);
    const markerLen = m ? line.length - m[7].length : 0;

    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(); return; }

    // Shift+Enter — continue the list you're in, or step out of an empty item.
    if (e.key === "Enter" && e.shiftKey && m) {
      e.preventDefault();
      if (!m[7].trim()) { replaceRange(el, ls, le, m[1], ls + m[1].length); return; } // empty item → drop the marker
      const next = m[2]
        ? `${m[1]}${Number(m[2]) + 1}${m[3]}${m[5]}${m[6] ? "[ ] " : ""}`
        : `${m[1]}${m[4]}${m[5]}${m[6] ? "[ ] " : ""}`;
      replaceRange(el, caret, caret, "\n" + next);
      renumberRun(el);
      return;
    }

    // Tab / Shift+Tab nest a list item. Outside a list, leave Tab alone so focus still moves.
    if (e.key === "Tab" && m) {
      e.preventDefault();
      if (e.shiftKey) {
        if (!m[1]) return;
        const drop = m[1].startsWith(INDENT) ? INDENT.length : 1;
        replaceRange(el, ls, ls + drop, "", Math.max(ls, caret - drop));
      } else {
        replaceRange(el, ls, ls, INDENT, caret + INDENT.length);
      }
      renumberRun(el);
      return;
    }

    // Backspace right after a marker removes the marker instead of eating into it.
    if (e.key === "Backspace" && m && el.selectionStart === el.selectionEnd && caret === ls + markerLen) {
      e.preventDefault();
      replaceRange(el, ls, caret, m[1], ls + m[1].length);
      renumberRun(el);
    }
  };

  // Trailing newline needs a trailing glyph or the mirror comes up one line short.
  const lines = (value + (value.endsWith("\n") ? "​" : "")).split("\n");

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={mirror}
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap text-sm leading-relaxed text-neutral-100 [overflow-wrap:break-word]"
      >
        {lines.map((l, i) => (
          <span key={i}>{tintLine(l, `l${i}`)}{i < lines.length - 1 ? "\n" : ""}</span>
        ))}
      </div>
      <textarea
        ref={ref}
        value={value}
        rows={1}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={() => { if (mirror.current && ref.current) mirror.current.scrollTop = ref.current.scrollTop; }}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        className="relative block max-h-[220px] w-full resize-none whitespace-pre-wrap bg-transparent text-sm leading-relaxed text-transparent caret-white outline-none [overflow-wrap:break-word] selection:bg-[var(--sakura)]/35 placeholder:text-neutral-600"
      />
    </div>
  );
}
