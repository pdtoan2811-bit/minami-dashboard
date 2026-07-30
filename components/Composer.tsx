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
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useDensityTier, type Density } from "@/lib/density";

// useLayoutEffect is a no-op (and warns) during Next's server prerender.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

// How tall the box may grow before it scrolls instead — a share of the pane, not a constant.
//
// 220px is the right ceiling in a full-width pane and a catastrophe in a cramped one: a four-pane grid
// gives each column ~250-350px of height in total, so a fifteen-line draft grew the composer over the
// entire conversation and left the transcript with nothing. You'd be typing a message about a reply you
// could no longer see. The tier comes from the pane that owns this composer (lib/density.ts), not from
// the composer's own width, because it's the pane's HEIGHT this is rationing.
const MAX_H: Record<Density, number> = { roomy: 220, snug: 180, tight: 110, micro: 72 };

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
// The image-path alternatives go LAST so every existing token still wins first — a path inside a code
// span is already claimed by the backtick branch and must keep rendering as code.
//
// They exist because an attached image is an absolute path, and an absolute path is long: pasted into
// a narrow pane it wraps over three lines and visually becomes the message. Tinting it as a chip
// (directory dimmed, filename accented) keeps the text itself untouched — the textarea is still the
// single source of truth — while letting the eye skip it the way it skips a filename in a chat app.
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)|"\/[^"\n]+\.(?:png|jpe?g|gif|webp)"|\/[^\s"'()]+\.(?:png|jpe?g|gif|webp))/g;

/** A token that is an image path (quoted or bare), per the last two INLINE alternatives. */
const isImagePath = (tok: string) => /^"?\/.*\.(?:png|jpe?g|gif|webp)"?$/i.test(tok);

function tintInline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, k = 0, m: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const kk = `${key}i${k++}`;
    if (tok.startsWith("`")) {
      // chip-wrap: a code span that wraps must draw a whole box on each line, not one box sliced in
      // half with its first fragment bleeding to the edge of the line — see globals.css.
      out.push(<span key={kk} className="chip-wrap rounded-[3px] bg-white/[0.07] text-[#e8b3c0]">{tok}</span>);
    } else if (isImagePath(tok)) {
      // Split at the last slash: the directory is noise, the filename is what identifies it.
      const cut = tok.lastIndexOf("/") + 1;
      out.push(
        <span key={kk} className="chip-wrap rounded-[3px] bg-white/[0.07]">
          <span className={DIM}>{tok.slice(0, cut)}</span>
          <span className={ACCENT}>{tok.slice(cut)}</span>
        </span>,
      );
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

/* ---------------- caret visibility ---------------- */

// Where the caret sits, in content pixels. Nothing in the textarea API reports this, and counting
// "\n"s is wrong the moment a line soft-wraps — which, in a 220px box, is most of them. The mirror
// solves it: it holds the same characters at the same metrics as the textarea, so a collapsed Range
// over its text nodes lands exactly where the caret is, wraps included.
function caretY(mirrorEl: HTMLElement, index: number): number | null {
  const walk = document.createTreeWalker(mirrorEl, NodeFilter.SHOW_TEXT);
  let seen = 0, node: Node | null;
  while ((node = walk.nextNode())) {
    const len = node.nodeValue?.length ?? 0;
    if (seen + len >= index) {
      const off = index - seen;
      const r = document.createRange();
      r.setStart(node, off);
      r.setEnd(node, off);
      let rect = r.getBoundingClientRect();
      // A collapsed range can measure 0×0 at a line boundary. Widen it by one character — either
      // direction works, both sit on the caret's line.
      if (!rect.height) {
        if (off < len) r.setEnd(node, off + 1);
        else if (off > 0) r.setStart(node, off - 1);
        rect = r.getBoundingClientRect();
      }
      if (!rect.height) return null;
      return rect.top - mirrorEl.getBoundingClientRect().top + mirrorEl.scrollTop;
    }
    seen += len;
  }
  return null;
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
  const maxH = MAX_H[useDensityTier()];

  // Scroll the caret back into view. Only ever needed once the composer has hit MAX_H and started
  // scrolling — which is exactly when a Shift+Enter used to insert a line you couldn't see.
  const followCaret = () => {
    const el = ref.current, mi = mirror.current;
    if (!el || !mi || el.scrollHeight <= el.clientHeight + 1) return;
    // Track the END that moves: during a downward drag-select the anchor stays put, and chasing it
    // would yank the view back to where the selection started.
    const pos = el.selectionDirection === "backward" ? el.selectionStart : el.selectionEnd;
    const y = caretY(mi, pos);
    if (y == null) return;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + lh > el.scrollTop + el.clientHeight) el.scrollTop = y + lh - el.clientHeight;
    mi.scrollTop = el.scrollTop;
  };

  // Grow to fit the content, then scroll. Runs before paint so there's no visible reflow jump.
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // An EMPTY box is exactly one row — never measured.
    //
    // `scrollHeight` on an empty textarea reports the height of the wrapped PLACEHOLDER, because the
    // browser lays that text out for real. So auto-grow was sizing the box to a string the user hasn't
    // typed: "Message Claude in minami-dashboard…" wraps to three lines in a 150px pane (measured:
    // scrollHeight 68px with an empty value), and the composer sat there as a tall empty box that
    // changed shape with the project's name and the pane's width. Clearing the inline height hands
    // sizing back to `rows={1}`, which is the honest answer for "no content".
    if (!value) {
      el.style.height = "";
      el.style.overflowY = "hidden";
      if (mirror.current) mirror.current.scrollTop = 0;
      return;
    }
    // The `height:auto` probe below makes the box briefly tall enough to hold everything, which zeroes
    // scrollTop — and the browser does NOT restore it when the height snaps back. That's what made a
    // newline at the bottom of a long draft land off-screen: it existed, the view had just jumped
    // elsewhere. Save the offset across the measurement, then follow the caret from wherever it lands.
    const prev = el.scrollTop;
    el.style.height = "auto";
    const h = Math.min(el.scrollHeight, maxH);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
    el.scrollTop = prev;
    followCaret();
    if (mirror.current) mirror.current.scrollTop = el.scrollTop;
    // `maxH` is a dependency, not a constant read: a pane that shrinks (a fourth chat opened, the
    // divider dragged) must re-clamp a draft that's already too tall, not keep the height it had.
  }, [value, maxH]);

  // Paste an image straight into the box. The bytes go to disk and the PATH is inserted as text —
  // which keeps this composer's one invariant (the textarea is the only source of truth for what
  // Claude receives) and means a pasted screenshot and a folder-picker attachment are the same thing
  // downstream. /api/agent/send reads whatever paths the message mentions and ships them inline, so
  // Claude sees the picture without spending a Read call, while the path is what survives into the
  // transcript for the thumbnail to come back after a reload.
  const [pasting, setPasting] = useState(0);
  const [pasteError, setPasteError] = useState<string | null>(null);

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    // Only intercept when there is actually an image. Text, and a copied file's *name*, must paste
    // exactly as before — a paste handler that swallows ordinary Cmd-V is far worse than no paste
    // handler at all.
    if (files.length === 0) return;
    e.preventDefault();
    setPasteError(null);

    for (const f of files) {
      setPasting((n) => n + 1);
      fetch("/api/fs/paste", { method: "POST", headers: { "content-type": f.type }, body: f })
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d?.path) throw new Error(d?.error || `upload failed (${r.status})`);
          const el = ref.current;
          if (!el) return;
          // Insert at wherever the caret is NOW — the upload is async and the user may well have kept
          // typing. Pad so the path can't fuse with adjacent words and break the path regex.
          const at = el.selectionStart;
          const before = el.value.slice(0, at);
          const lead = before && !/\s$/.test(before) ? " " : "";
          replaceRange(el, at, at, `${lead}${d.path} `);
        })
        .catch((err) => setPasteError(String(err?.message || err)))
        .finally(() => setPasting((n) => n - 1));
    }
  };

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
        onPaste={onPaste}
        // Arrowing or clicking up into a long draft moves the caret without changing the value, so the
        // layout effect never fires — this is the other half of keeping it on screen.
        onSelect={followCaret}
        onScroll={() => { if (mirror.current && ref.current) mirror.current.scrollTop = ref.current.scrollTop; }}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        // Inline, not a Tailwind class: the ceiling is now a number the pane decides, and a static
        // `max-h-[220px]` would silently overrule it for anything the layout effect above didn't set.
        style={{ maxHeight: maxH }}
        className="relative block w-full resize-none whitespace-pre-wrap bg-transparent text-sm leading-relaxed text-transparent caret-white outline-none [overflow-wrap:break-word] selection:bg-[var(--sakura)]/35 placeholder:text-neutral-600"
      />
      {/* An upload is a beat of dead time between Cmd-V and the path appearing; without this the
          composer looks like it ignored the paste. Absolute so it can't reflow the growing textarea. */}
      {(pasting > 0 || pasteError) && (
        <div className="pointer-events-none absolute -top-5 left-0 text-[10px]">
          {pasting > 0
            ? <span className="text-neutral-500">saving image{pasting > 1 ? `s (${pasting})` : ""}…</span>
            : <span className="text-[#ef7c7c]">{pasteError}</span>}
        </div>
      )}
    </div>
  );
}
