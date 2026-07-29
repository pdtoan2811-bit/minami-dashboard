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

/* ---------------- block parser ---------------- */
function renderProse(src: string, keyBase: string, tone: Tone = "chat", caret = false): ReactNode {
  const T = TONE[tone];
  const lines = src.split("\n");
  // Index of the last line with content, so a streaming caret can ride the end of the final
  // paragraph instead of dangling on a line of its own below the text.
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) { lastIdx = i; break; }
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: { text: string; task?: boolean; done?: boolean }[] } | null = null;
  const flushList = () => {
    if (!list) return;
    const L = list; list = null;
    const cls = "my-1.5 ml-4 space-y-1 " + (L.ordered ? "list-decimal" : "list-disc") + " " + T.marker;
    out.push(
      <ul key={`${keyBase}l${out.length}`} className={L.ordered ? cls.replace("list-disc", "") : cls} style={L.ordered ? { listStyleType: "decimal" } : undefined}>
        {L.items.map((it, i) => it.task
          ? <li key={i} className="list-none -ml-4 flex items-start gap-2"><span className={`mt-[3px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${it.done ? "border-[var(--sakura)] bg-[var(--sakura)] text-white" : "border-white/25"}`}>{it.done ? "✓" : ""}</span><span className={it.done ? "text-neutral-500 line-through" : ""}>{inline(it.text, `${keyBase}li${i}`, tone)}</span></li>
          : <li key={i}>{inline(it.text, `${keyBase}li${i}`, tone)}</li>)}
      </ul>,
    );
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.replace(/\s+$/, "");
    // table: header row + separator row
    if (/^\s*\|?.+\|.+/.test(t) && /^\s*\|?[\s:-]*-[-\s:|]*\|?\s*$/.test(lines[i + 1] || "")) {
      const head = cells(t);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && /\|/.test(lines[j]) && lines[j].trim()) { rows.push(cells(lines[j])); j++; }
      flushList();
      out.push(<Table key={`${keyBase}t${out.length}`} head={head} rows={rows} tone={tone} />);
      i = j - 1;
      continue;
    }
    const task = t.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)/);
    if (task) { if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; } list.items.push({ text: task[2], task: true, done: task[1].toLowerCase() === "x" }); continue; }
    const ul = t.match(/^\s*[-*•]\s+(.*)/);
    if (ul) { if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; } list.items.push({ text: ul[1] }); continue; }
    const ol = t.match(/^\s*\d+[.)]\s+(.*)/);
    if (ol) { if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; } list.items.push({ text: ol[1] }); continue; }
    flushList();
    if (!t.trim()) continue;
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(t)) { out.push(<hr key={`${keyBase}h${out.length}`} className={`my-2 ${T.rule}`} />); continue; }
    const bq = t.match(/^\s*>\s?(.*)/);
    if (bq) { out.push(<blockquote key={`${keyBase}q${out.length}`} className={`my-1 border-l-2 pl-3 ${T.quote}`}>{inline(bq[1], `${keyBase}q${out.length}`, tone)}</blockquote>); continue; }
    const h = t.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      const size = tone === "thought" ? "text-[12px] uppercase tracking-[0.06em]" : h[1].length <= 1 ? "text-[15px]" : "text-[13px]";
      out.push(<p key={`${keyBase}hd${out.length}`} className={`pt-0.5 font-semibold ${T.head} ${size}`}>{inline(h[2], `${keyBase}hd${out.length}`, tone)}</p>);
      continue;
    }
    out.push(
      <p key={`${keyBase}p${out.length}`} className={`${T.lead} [overflow-wrap:anywhere]`}>
        {inline(t, `${keyBase}p${out.length}`, tone)}
        {caret && i === lastIdx && <span className="ml-0.5 inline-block h-[0.95em] w-[2px] animate-pulse align-[-0.13em]" style={{ background: "var(--sakura)" }} />}
      </p>,
    );
  }
  flushList();
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
