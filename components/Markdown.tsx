"use client";
// Rich message renderer for the chat panel — GFM-ish, dependency-light, styled to match Bento.
// Supports: fenced code (highlight.js + copy), tables, ordered/unordered/task lists, blockquotes,
// headings, horizontal rules, and inline code/bold/italic/strikethrough/links. Built to feel like
// the Claude Code terminal output.
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import { memo, useMemo, useState, type ReactNode } from "react";

/* ---------------- tone ----------------
   Reasoning is a second voice, not a second-class one: it gets the SAME parser as the answer — so a
   bulleted list or a bold lead-in inside a thought reads as one — and differs only in contrast, one
   step back from the reply. Keeping it as a palette here (rather than a separate thought renderer)
   is what stops the two from drifting apart the next time a block type is added. */
export type Tone = "chat" | "thought";
const TONE = {
  chat: {
    strong: "text-white", em: "text-neutral-200", code: "bg-white/10 text-[#e8b3c0]",
    head: "text-white", quote: "border-[var(--sakura)]/50 text-neutral-300",
    rule: "border-white/10", marker: "marker:text-neutral-600", lead: "leading-[1.72]", gap: "space-y-2",
  },
  thought: {
    strong: "text-neutral-200", em: "text-neutral-400", code: "bg-white/[0.07] text-[#cf9fac]",
    head: "text-neutral-300", quote: "border-white/15 text-neutral-400",
    rule: "border-white/[0.07]", marker: "marker:text-neutral-700", lead: "leading-[1.78]", gap: "space-y-3",
  },
} satisfies Record<Tone, Record<string, string>>;

/* ---------------- inline ---------------- */
// Order matters: code first (so its contents aren't re-parsed), then links, bold, italic, strike.
function inline(text: string, keyBase = "", tone: Tone = "chat"): ReactNode[] {
  const T = TONE[tone];
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0, k = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}i${k++}`;
    if (tok.startsWith("`")) nodes.push(<code key={key} className={`chip-wrap rounded px-1 py-[1px] font-mono text-[0.88em] ${T.code}`}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      nodes.push(<a key={key} href={mm[2]} target="_blank" rel="noreferrer" className="text-[var(--sakura)] underline decoration-[var(--sakura)]/40 underline-offset-2 hover:decoration-[var(--sakura)]">{mm[1]}</a>);
    } else if (tok.startsWith("**") || tok.startsWith("__")) nodes.push(<strong key={key} className={`font-semibold ${T.strong}`}>{inline(tok.slice(2, -2), key, tone)}</strong>);
    else if (tok.startsWith("~~")) nodes.push(<span key={key} className="text-neutral-500 line-through">{tok.slice(2, -2)}</span>);
    else nodes.push(<em key={key} className={`italic ${T.em}`}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/* ---------------- code block ---------------- */
function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  // Highlighting is expensive; memoize so a re-render (poll, sibling streaming) doesn't re-run it.
  const html = useMemo(() => {
    try { return lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value; }
    catch { return code.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string)); }
  }, [code, lang]);
  const copy = () => { navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };
  return (
    <div className="group/code my-1 overflow-hidden rounded-xl border border-white/10 bg-[#0d1117]">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">{lang || "code"}</span>
        <button onClick={copy} className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 opacity-0 transition-[opacity,color,background-color] hover:bg-white/10 hover:text-neutral-300 group-hover/code:opacity-100">{copied ? "copied" : "copy"}</button>
      </div>
      <pre className="hljs overflow-x-auto bg-transparent p-3 text-[13px] leading-[1.62]"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  );
}

/* ---------------- table ---------------- */
const cells = (row: string) => row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
function Table({ head, rows, tone = "chat" }: { head: string[]; rows: string[][]; tone?: Tone }) {
  return (
    <div className="my-1 overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full border-collapse text-[13px]">
        <thead className="bg-white/[0.04] text-left text-neutral-300">
          <tr>{head.map((h, i) => <th key={i} className="border-b border-white/10 px-3 py-1.5 font-semibold">{inline(h, `th${i}`, tone)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-white/[0.06] last:border-0">
              {r.map((c, ci) => <td key={ci} className={`px-3 py-1.5 align-top [overflow-wrap:anywhere] ${tone === "thought" ? "text-neutral-400" : "text-neutral-200"}`}>{inline(c, `td${ri}-${ci}`, tone)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- lists ---------------- */
// A list is a TREE, and the indentation you typed is what shapes it. The first version of this parser
// matched `^\s*[-*•]\s+` and then threw the captured indent away, so every bullet in a message became
// a sibling of every other one: a three-level plan came out as one flat column, and the structure the
// writer used to carry their meaning was the exact thing that got dropped. Continuation lines fared
// worse — an indented line under a bullet ended the list and reappeared as a paragraph *after* it.
type LItem = { text: string; task?: boolean; done?: boolean; kids: LList[] };
type LList = { ordered: boolean; start: number; indent: number; items: LItem[] };

// Marker forms accepted on purpose: `-` `*` `+` `•` and `1.` / `1)`. `•` because people paste from
// somewhere that already bulleted for them, and being strict there just punishes the paste.
const LIST_LINE = /^(\s*)(?:([-*+•])|(\d+)[.)])\s+(.*)$/;
// Tabs count as two columns. Any consistent rule works; not having one is what breaks mixed indents.
const indentOf = (s: string) => (/^\s*/.exec(s)?.[0] || "").replace(/\t/g, "  ").length;

// Consume a run of list lines starting at `from`, returning the trees and the line after the run.
function takeList(lines: string[], from: number): { roots: LList[]; next: number } {
  const roots: LList[] = [];
  const stack: LList[] = [];
  let last: LItem | null = null;
  let i = from;

  while (i < lines.length) {
    const m = LIST_LINE.exec(lines[i]);
    if (m) {
      const indent = indentOf(m[1]);
      const ordered = !!m[3];
      let text = m[4];
      let task: boolean | undefined, done: boolean | undefined;
      const tm = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (tm) { task = true; done = tm[1].toLowerCase() === "x"; text = tm[2]; }

      // Close every level indented deeper than this line before placing it.
      while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
      let cur: LList | undefined = stack[stack.length - 1];

      if (!cur || indent > cur.indent) {
        // Deeper than the open level (or the very first item) → a child list hanging off the last item.
        const list: LList = { ordered, start: ordered ? parseInt(m[3], 10) || 1 : 1, indent, items: [] };
        if (cur && last) last.kids.push(list); else roots.push(list);
        stack.push(list);
        cur = list;
      } else if (cur.ordered !== ordered) {
        // Same depth, other kind — a numbered run under a bulleted one is a NEW list, not a continuation.
        stack.pop();
        const parent = stack[stack.length - 1];
        const list: LList = { ordered, start: ordered ? parseInt(m[3], 10) || 1 : 1, indent, items: [] };
        const host = parent?.items[parent.items.length - 1];
        if (host) host.kids.push(list); else roots.push(list);
        stack.push(list);
        cur = list;
      }

      const item: LItem = { text, task, done, kids: [] };
      cur.items.push(item);
      last = item;
      i++;
      continue;
    }

    // A non-marker line indented past the open list belongs to the item above it — that's a wrapped
    // sentence or a second paragraph of the same bullet, and it keeps the item's hanging indent.
    if (lines[i].trim() && last && indentOf(lines[i]) > (stack[stack.length - 1]?.indent ?? 0)) {
      last.text += "\n" + lines[i].trim();
      i++;
      continue;
    }

    // A blank line only ends the list if what follows isn't another item — otherwise this is an
    // ordinary "loose" list with air between its entries, which is how most people write them.
    if (!lines[i].trim()) {
      let k = i + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && LIST_LINE.test(lines[k])) { i = k; continue; }
    }
    break;
  }
  return { roots, next: i };
}

function List({ L, keyBase, tone, caret }: { L: LList; keyBase: string; tone: Tone; caret?: boolean }) {
  const T = TONE[tone];
  const Tag = (L.ordered ? "ol" : "ul") as "ol" | "ul";
  // `pl-5` + the default `list-outside` is what produces a real hanging indent: the marker sits in the
  // padding and every wrapped line lands under the item's first character, not under the bullet.
  const marker = L.ordered ? "list-decimal" : "list-disc";
  return (
    <Tag start={L.ordered && L.start !== 1 ? L.start : undefined} className={`my-1.5 space-y-1 pl-5 ${marker} ${T.marker}`}>
      {L.items.map((it, i) => {
        const lastOne = caret && i === L.items.length - 1;
        return (
          <li key={i} className={it.task ? "-ml-5 flex list-none items-start gap-2" : undefined}>
            {it.task && (
              <span className={`mt-[3px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${it.done ? "border-[var(--sakura)] bg-[var(--sakura)] text-white" : "border-white/25"}`}>{it.done ? "✓" : ""}</span>
            )}
            <span className={`min-w-0 ${it.done ? "text-neutral-500 line-through" : ""}`}>
              {inlineLines(it.text, `${keyBase}i${i}`, tone)}
              {lastOne && !it.kids.length && <Caret />}
              {it.kids.map((k, ki) => <List key={ki} L={k} keyBase={`${keyBase}i${i}k${ki}`} tone={tone} caret={lastOne} />)}
            </span>
          </li>
        );
      })}
    </Tag>
  );
}

const Caret = () => <span className="ml-0.5 inline-block h-[0.95em] w-[2px] animate-pulse align-[-0.13em]" style={{ background: "var(--sakura)" }} />;

// A single newline is a LINE BREAK here, not a space. Strict markdown folds it into the paragraph, but
// this is a chat panel: people press Enter to mean "new line", and rendering their address block or
// their three short points as one run-on sentence is never what they asked for. Every chat client that
// people compare this to (Claude Code among them) treats it the same way.
function inlineLines(text: string, keyBase: string, tone: Tone): ReactNode[] {
  const parts = text.split("\n");
  const nodes: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (i) nodes.push(<br key={`${keyBase}br${i}`} />);
    nodes.push(...inline(p, `${keyBase}L${i}`, tone));
  });
  return nodes;
}

/* ---------------- block parser ---------------- */
function renderProse(src: string, keyBase: string, tone: Tone = "chat", caret = false): ReactNode {
  const T = TONE[tone];
  const lines = src.split("\n");
  // Index of the last line with content, so a streaming caret can ride the end of the final block
  // instead of dangling on a line of its own below the text.
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) { lastIdx = i; break; }
  const out: ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.replace(/\s+$/, "");

    if (!t.trim()) continue;

    // table: header row + separator row
    if (/^\s*\|?.+\|.+/.test(t) && /^\s*\|?[\s:-]*-[-\s:|]*\|?\s*$/.test(lines[i + 1] || "")) {
      const head = cells(t);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && /\|/.test(lines[j]) && lines[j].trim()) { rows.push(cells(lines[j])); j++; }
      out.push(<Table key={`${keyBase}t${out.length}`} head={head} rows={rows} tone={tone} />);
      i = j - 1;
      continue;
    }

    // Tested BEFORE the list, or `- - -` would be read as a bullet holding a dash.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(t)) { out.push(<hr key={`${keyBase}h${out.length}`} className={`my-2 ${T.rule}`} />); continue; }

    if (LIST_LINE.test(raw)) {
      const { roots, next } = takeList(lines, i);
      const holds = caret && lastIdx >= i && lastIdx < next;
      out.push(
        <div key={`${keyBase}l${out.length}`}>
          {roots.map((r, ri) => <List key={ri} L={r} keyBase={`${keyBase}l${out.length}r${ri}`} tone={tone} caret={holds && ri === roots.length - 1} />)}
        </div>,
      );
      i = next - 1;
      continue;
    }

    // Consecutive `>` lines are ONE quote. Rendered per-line before, a two-line quotation came out as
    // two stacked bars, which reads as two separate quotations.
    if (/^\s*>\s?/.test(t)) {
      const buf: string[] = [];
      let j = i;
      while (j < lines.length && /^\s*>\s?/.test(lines[j])) { buf.push(lines[j].replace(/^\s*>\s?/, "")); j++; }
      out.push(
        <blockquote key={`${keyBase}q${out.length}`} className={`my-1 border-l-2 pl-3 ${T.quote}`}>
          {inlineLines(buf.join("\n"), `${keyBase}q${out.length}`, tone)}
        </blockquote>,
      );
      i = j - 1;
      continue;
    }

    const h = t.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      const size = tone === "thought" ? "text-[12px] uppercase tracking-[0.06em]" : h[1].length <= 1 ? "text-[15px]" : "text-[13px]";
      out.push(<p key={`${keyBase}hd${out.length}`} className={`pt-0.5 font-semibold ${T.head} ${size}`}>{inline(h[2], `${keyBase}hd${out.length}`, tone)}</p>);
      continue;
    }

    // Gather the whole paragraph — every following line until a blank one or the start of another
    // block. Emitting one <p> per line meant `space-y` put a full paragraph's air between two lines of
    // a single thought, so a wrapped sentence looked like two unrelated statements.
    const buf: string[] = [t];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const n = lines[j];
      if (!n.trim()) break;
      if (LIST_LINE.test(n) || /^\s*>\s?/.test(n) || /^(#{1,4})\s+/.test(n)) break;
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(n)) break;
      if (/^\s*\|?.+\|.+/.test(n) && /^\s*\|?[\s:-]*-[-\s:|]*\|?\s*$/.test(lines[j + 1] || "")) break;
      buf.push(n.replace(/\s+$/, ""));
    }
    out.push(
      <p key={`${keyBase}p${out.length}`} className={`${T.lead} [overflow-wrap:anywhere]`}>
        {inlineLines(buf.join("\n"), `${keyBase}p${out.length}`, tone)}
        {caret && lastIdx >= i && lastIdx < j && <Caret />}
      </p>,
    );
    i = j - 1;
  }
  return <div className={T.gap}>{out}</div>;
}

// `caret`: park a pulsing cursor at the end of the last paragraph while this text is still streaming.
function Markdown({ text, tone = "chat", caret = false }: { text: string; tone?: Tone; caret?: boolean }) {
  // Split on fenced code first so prose parsing never touches code contents.
  const blocks = useMemo(() => text.split(/(```[\s\S]*?```)/g).filter(Boolean), [text]);
  return (
    <div className={TONE[tone].gap}>
      {blocks.map((b, i) => {
        if (b.startsWith("```")) {
          const lang = (b.match(/^```([\w-]+)/) || [])[1];
          const inner = b.replace(/^```[\w-]*\n?/, "").replace(/\n?```$/, "");
          return <CodeBlock key={i} lang={lang} code={inner} />;
        }
        return <div key={i}>{renderProse(b, `b${i}`, tone, caret && i === blocks.length - 1)}</div>;
      })}
    </div>
  );
}

// Messages are immutable once rendered (only the streaming one changes), so memo on `text` stops every
// other bubble from re-rendering on each poll or streamed token — the biggest win for long transcripts.
export default memo(Markdown);
