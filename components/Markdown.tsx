"use client";
// Rich message renderer for the chat panel — GFM-ish, dependency-light, styled to match Bento.
// Supports: fenced code (highlight.js + copy), tables, ordered/unordered/task lists, blockquotes,
// headings, horizontal rules, and inline code/bold/italic/strikethrough/links. Built to feel like
// the Claude Code terminal output.
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import { useState, type ReactNode } from "react";

/* ---------------- inline ---------------- */
// Order matters: code first (so its contents aren't re-parsed), then links, bold, italic, strike.
function inline(text: string, keyBase = ""): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0, k = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}i${k++}`;
    if (tok.startsWith("`")) nodes.push(<code key={key} className="rounded bg-white/10 px-1 py-[1px] font-mono text-[0.85em] text-[#e8b3c0]">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      nodes.push(<a key={key} href={mm[2]} target="_blank" rel="noreferrer" className="text-[var(--sakura)] underline decoration-[var(--sakura)]/40 underline-offset-2 hover:decoration-[var(--sakura)]">{mm[1]}</a>);
    } else if (tok.startsWith("**") || tok.startsWith("__")) nodes.push(<strong key={key} className="font-semibold text-white">{inline(tok.slice(2, -2), key)}</strong>);
    else if (tok.startsWith("~~")) nodes.push(<span key={key} className="text-neutral-500 line-through">{tok.slice(2, -2)}</span>);
    else nodes.push(<em key={key} className="italic text-neutral-200">{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/* ---------------- code block ---------------- */
function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  let html = "";
  try { html = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value; }
  catch { html = code.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string)); }
  const copy = () => { navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };
  return (
    <div className="group/code my-1 overflow-hidden rounded-xl border border-white/10 bg-[#0d1117]">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">{lang || "code"}</span>
        <button onClick={copy} className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 opacity-0 transition-all hover:bg-white/10 hover:text-neutral-300 group-hover/code:opacity-100">{copied ? "copied" : "copy"}</button>
      </div>
      <pre className="hljs overflow-x-auto bg-transparent p-3 text-[12.5px] leading-relaxed"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  );
}

/* ---------------- table ---------------- */
const cells = (row: string) => row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="my-1 overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full border-collapse text-[13px]">
        <thead className="bg-white/[0.04] text-left text-neutral-300">
          <tr>{head.map((h, i) => <th key={i} className="border-b border-white/10 px-3 py-1.5 font-semibold">{inline(h, `th${i}`)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-white/[0.06] last:border-0">
              {r.map((c, ci) => <td key={ci} className="px-3 py-1.5 align-top text-neutral-200 [overflow-wrap:anywhere]">{inline(c, `td${ri}-${ci}`)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- block parser ---------------- */
function renderProse(src: string, keyBase: string): ReactNode {
  const lines = src.split("\n");
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: { text: string; task?: boolean; done?: boolean }[] } | null = null;
  const flushList = () => {
    if (!list) return;
    const L = list; list = null;
    const cls = "my-1 ml-4 space-y-0.5 " + (L.ordered ? "list-decimal" : "list-disc") + " marker:text-neutral-600";
    out.push(
      <ul key={`${keyBase}l${out.length}`} className={L.ordered ? cls.replace("list-disc", "") : cls} style={L.ordered ? { listStyleType: "decimal" } : undefined}>
        {L.items.map((it, i) => it.task
          ? <li key={i} className="list-none -ml-4 flex items-start gap-2"><span className={`mt-[3px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${it.done ? "border-[var(--sakura)] bg-[var(--sakura)] text-white" : "border-white/25"}`}>{it.done ? "✓" : ""}</span><span className={it.done ? "text-neutral-500 line-through" : ""}>{inline(it.text, `${keyBase}li${i}`)}</span></li>
          : <li key={i}>{inline(it.text, `${keyBase}li${i}`)}</li>)}
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
      out.push(<Table key={`${keyBase}t${out.length}`} head={head} rows={rows} />);
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
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(t)) { out.push(<hr key={`${keyBase}h${out.length}`} className="my-2 border-white/10" />); continue; }
    const bq = t.match(/^\s*>\s?(.*)/);
    if (bq) { out.push(<blockquote key={`${keyBase}q${out.length}`} className="my-1 border-l-2 border-[var(--sakura)]/50 pl-3 text-neutral-300">{inline(bq[1], `${keyBase}q${out.length}`)}</blockquote>); continue; }
    const h = t.match(/^(#{1,4})\s+(.*)/);
    if (h) { const size = h[1].length <= 1 ? "text-[15px]" : "text-[13px]"; out.push(<p key={`${keyBase}hd${out.length}`} className={`pt-0.5 font-semibold text-white ${size}`}>{inline(h[2], `${keyBase}hd${out.length}`)}</p>); continue; }
    out.push(<p key={`${keyBase}p${out.length}`} className="leading-relaxed [overflow-wrap:anywhere]">{inline(t, `${keyBase}p${out.length}`)}</p>);
  }
  flushList();
  return <div className="space-y-1.5">{out}</div>;
}

export default function Markdown({ text }: { text: string }) {
  // Split on fenced code first so prose parsing never touches code contents.
  const blocks = text.split(/(```[\s\S]*?```)/g).filter(Boolean);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        if (b.startsWith("```")) {
          const lang = (b.match(/^```([\w-]+)/) || [])[1];
          const inner = b.replace(/^```[\w-]*\n?/, "").replace(/\n?```$/, "");
          return <CodeBlock key={i} lang={lang} code={inner} />;
        }
        return <div key={i}>{renderProse(b, `b${i}`)}</div>;
      })}
    </div>
  );
}
