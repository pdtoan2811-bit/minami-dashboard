"use client";

// The file preview panel — the file analogue of BrowserPanel, and deliberately built to its shape:
// docked beside the chat, resizable, side-or-stacked, with a rail of what's been touched.
//
// The brief was "not just code". So this routes by KIND, not by "is it text": a designer opening a
// PNG, a marketer opening a CSV or a PDF, and an engineer opening a .tsx should each get the view that
// suits the thing, rather than a wall of characters. What the file IS decides how it renders —
// `.ipynb` is JSON on disk and a notebook to a human, and that gap is the whole point.
//
// Content is always fetched fresh from /api/fs/file rather than reconstructed from the transcript: the
// transcript records that a file was written, not what is in it NOW, and now is what you want to see.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import { FileCode2, FileText, Image as ImageIcon, Loader2, PanelBottom, PanelRight, RefreshCw, Sheet, X } from "lucide-react";
import Markdown from "./Markdown";
import { PanelTabs } from "./PanelTabs";
import type { FileState, TouchedFile } from "@/lib/file-view";

type Kind = "code" | "markdown" | "notebook" | "csv" | "json" | "text" | "image" | "pdf" | "video" | "audio" | "binary";

type Meta = {
  path: string; name: string; kind: Kind; size: number; mtime: number; ext: string;
  text?: string; offset?: number; nextOffset?: number | null; truncated?: boolean; lines?: number;
  servedRaw?: boolean; binary?: boolean; error?: string;
};

const VERB_TINT: Record<string, string> = { created: "#1f8a5c", changed: "#c47f18", read: "#4e5665" };

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const rawUrl = (p: string) => `/api/fs/file?raw=1&path=${encodeURIComponent(p)}`;

/** highlight.js language from an extension. Returning undefined (rather than guessing) makes the
 *  renderer fall back to `highlightAuto`, which is right for an unknown extension and wrong for a
 *  known one — mislabelling .tsx as, say, xml produces confidently incorrect colouring. */
const LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".rb": "ruby", ".go": "go",
  ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift", ".c": "c", ".h": "c",
  ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".php": "php", ".sh": "bash", ".bash": "bash",
  ".zsh": "bash", ".sql": "sql", ".graphql": "graphql", ".css": "css", ".scss": "scss",
  ".less": "less", ".html": "xml", ".htm": "xml", ".xml": "xml", ".yml": "yaml", ".yaml": "yaml",
  ".toml": "ini", ".ini": "ini", ".conf": "ini", ".lua": "lua", ".dart": "dart", ".scala": "scala",
  ".json": "json", ".jsonl": "json",
};

const iconFor = (k: Kind) => (k === "image" || k === "pdf" || k === "video" ? ImageIcon : k === "csv" ? Sheet : k === "code" || k === "json" || k === "notebook" ? FileCode2 : FileText);

export default function FilePanel({
  state, cwd, stacked, activePath, onPick, onClose, onToggleLayout, onPopOut,
}: {
  state: FileState;
  cwd?: string;
  stacked: boolean;
  /** Which file to show. Controlled by the parent so a chip in the transcript can open a specific one. */
  activePath?: string | null;
  onPick: (p: string) => void;
  onClose?: () => void;
  onToggleLayout?: () => void;
  onPopOut?: () => void;
}) {
  const files = state.files;
  // Default to the most recently touched file — the one you almost always mean.
  const path = activePath || files[0]?.path || null;
  const active: TouchedFile | undefined = files.find((f) => f.path === path);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [raw, setRaw] = useState(false); // markdown/notebook: show source instead of rendered
  const [nonce, setNonce] = useState(0); // manual refresh — a file changes under you
  // Guards against a slow fetch for file A landing after the user has already clicked file B.
  const reqRef = useRef(0);

  useEffect(() => {
    if (!path) { setMeta(null); return; }
    const seq = ++reqRef.current;
    setLoading(true); setErr(null);
    fetch(`/api/fs/file?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((d: Meta) => {
        if (seq !== reqRef.current) return; // superseded
        if (d?.error) { setErr(d.error); setMeta(null); } else setMeta(d);
      })
      .catch((e) => { if (seq === reqRef.current) setErr(String(e?.message || e)); })
      .finally(() => { if (seq === reqRef.current) setLoading(false); });
  }, [path, nonce]);

  // Paging for huge files. Appends rather than replaces, so "load more" reads as continuing down the
  // file instead of jumping — and the request is byte-ranged, so the server never holds the whole file.
  const loadMore = useCallback(() => {
    if (!meta?.nextOffset || !path) return;
    const seq = reqRef.current;
    setLoading(true);
    fetch(`/api/fs/file?path=${encodeURIComponent(path)}&offset=${meta.nextOffset}`)
      .then((r) => r.json())
      .then((d: Meta) => {
        if (seq !== reqRef.current || d?.error) return;
        setMeta((m) => (m ? { ...m, text: (m.text || "") + (d.text || ""), nextOffset: d.nextOffset ?? null, truncated: !!d.truncated } : d));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [meta?.nextOffset, path]);

  useEffect(() => { setRaw(false); }, [path]); // a per-file toggle shouldn't persist across files

  const body = useMemo(() => {
    if (!path) return <Empty label="No file open" hint="Files Claude reads or writes appear here." />;
    if (err) return <Empty label="Couldn't open that" hint={err} />;
    if (!meta) return loading ? <Busy /> : <Empty label="No file open" hint="" />;

    switch (meta.kind) {
      case "image":
        // Uses the dedicated image route, which is magic-byte gated — a renamed .env can't be coaxed
        // through it. `key` on the nonce so Refresh actually refetches instead of using the cache.
        return <div className="flex h-full items-center justify-center overflow-auto bg-black/30 p-3">
          <img key={nonce} src={`/api/fs/image?path=${encodeURIComponent(meta.path)}`} alt={meta.name}
            className="max-h-full max-w-full object-contain" style={{ imageRendering: meta.size < 20000 ? "pixelated" : "auto" }} />
        </div>;
      case "pdf":
        return <embed key={nonce} src={rawUrl(meta.path)} type="application/pdf" className="h-full w-full" />;
      case "video":
        return <div className="flex h-full items-center justify-center bg-black/30 p-3"><video key={nonce} src={rawUrl(meta.path)} controls className="max-h-full max-w-full" /></div>;
      case "audio":
        return <div className="flex h-full items-center justify-center p-4"><audio key={nonce} src={rawUrl(meta.path)} controls className="w-full" /></div>;
      case "binary":
        return <Empty label="Not a previewable file" hint={`${meta.ext || "binary"} · ${fmtSize(meta.size)}. Binary content is detected and refused rather than shown as mojibake.`} />;
      case "csv":
        return <CsvTable text={meta.text || ""} tsv={meta.ext === ".tsv"} />;
      case "notebook":
        return raw ? <Code text={meta.text || ""} lang="json" /> : <Notebook text={meta.text || ""} />;
      case "markdown":
        return raw ? <Code text={meta.text || ""} lang="markdown" />
          : <div className="overflow-auto px-4 py-3 text-[13px]"><Markdown text={meta.text || ""} /></div>;
      default:
        return <Code text={meta.text || ""} lang={LANG[meta.ext]} />;
    }
  }, [meta, err, loading, path, raw, nonce]);

  const canToggleRaw = meta?.kind === "markdown" || meta?.kind === "notebook";

  return (
    // `@container`: everything below sizes off THIS PANEL's width, not the window's. A pane in a 2×2
    // grid is roughly a quarter of the screen, and at that size a 144px file rail leaves so little room
    // that prose wrapped one character per line — measured, not hypothetical.
    <div className="@container flex min-h-0 flex-1 flex-col overflow-hidden border-l border-white/10 bg-neutral-900/60">
      {/* chrome */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-2.5 py-1.5">
        <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-300" title={meta?.path || ""}>
          {meta?.name || "files"}
          {meta && <span className="ml-1.5 text-[9.5px] text-neutral-600">{fmtSize(meta.size)}{meta.lines ? ` · ${meta.lines} lines` : ""}</span>}
        </span>
        {canToggleRaw && (
          <button onClick={() => setRaw((v) => !v)} title={raw ? "Show rendered" : "Show source"}
            className="shrink-0 rounded-md border border-white/10 px-1.5 py-0.5 text-[9.5px] text-neutral-400 transition-colors hover:border-white/30 hover:text-neutral-200">
            {raw ? "rendered" : "source"}
          </button>
        )}
        <button onClick={() => setNonce((n) => n + 1)} title="Reload from disk"
          className="shrink-0 rounded-md p-1 text-neutral-500 transition-colors hover:text-neutral-200"><RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /></button>
        {onToggleLayout && <button onClick={onToggleLayout} title={stacked ? "Dock to the side" : "Dock below"}
          className="shrink-0 rounded-md p-1 text-neutral-500 transition-colors hover:text-neutral-200">{stacked ? <PanelRight className="h-3 w-3" /> : <PanelBottom className="h-3 w-3" />}</button>}
        {onPopOut && <button onClick={onPopOut} title="Open in a window"
          className="shrink-0 rounded-md p-1 text-neutral-500 transition-colors hover:text-neutral-200">↗</button>}
        {onClose && <button onClick={onClose} title="Hide the file panel"
          className="shrink-0 rounded-md p-1 text-neutral-500 transition-colors hover:text-neutral-200"><X className="h-3 w-3" /></button>}
      </div>

      {/* One tab per file touched. This replaced a 144px vertical rail AND the `<select>` that stood in
          for it below 340px — see components/PanelTabs.tsx for why height beats width here, and why
          having two navigation models depending on the panel's width was the worse half of it. */}
      {files.length > 1 && (
        <PanelTabs
          tabs={files.map((f) => {
            const Icon = iconFor(kindGuess(f.name));
            return {
              key: f.path,
              label: f.name,
              // The full path, because two files called `page.tsx` are the normal case in this repo and
              // the tab can only ever show the basename.
              title: f.path,
              tint: VERB_TINT[f.verb],
              icon: <Icon className="h-3 w-3 shrink-0 text-neutral-500" />,
            };
          })}
          active={path || ""}
          onPick={onPick}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto">{body}</div>
          {meta?.truncated && (
            <button onClick={loadMore} disabled={loading}
              className="shrink-0 border-t border-white/10 py-1.5 text-[10.5px] text-neutral-400 transition-colors hover:bg-white/5 hover:text-neutral-200 disabled:opacity-50">
              {loading ? "loading…" : `load more — showing ${fmtSize((meta.text || "").length)} of ${fmtSize(meta.size)}`}
            </button>
          )}
        </div>
      </div>

      {active && (
        <div className="shrink-0 border-t border-white/10 px-2.5 py-1 font-mono text-[9px] text-neutral-600">
          <span style={{ color: VERB_TINT[active.verb] }}>{active.verb}</span>
          {cwd && active.path.startsWith(cwd) ? ` · ${active.path.slice(cwd.length + 1)}` : ` · ${active.path}`}
        </div>
      )}
    </div>
  );
}

/** Extension → kind, for the rail's icon only. The server is authoritative for the real kind; this
 *  just avoids a fetch per rail entry to decide which glyph to draw. */
function kindGuess(name: string): Kind {
  const ext = "." + (name.split(".").pop() || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if ([".csv", ".tsv"].includes(ext)) return "csv";
  if ([".md", ".mdx"].includes(ext)) return "markdown";
  if (ext === ".ipynb") return "notebook";
  if ([".json", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".css", ".html", ".sh", ".yml", ".yaml"].includes(ext)) return "code";
  return "text";
}

function Busy() {
  return <div className="flex h-full items-center justify-center text-neutral-600"><Loader2 className="h-4 w-4 animate-spin" /></div>;
}

function Empty({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div>
        <p className="text-sm text-neutral-400">{label}</p>
        {hint && <p className="mx-auto mt-1 max-w-[22rem] text-[11px] leading-relaxed text-neutral-600">{hint}</p>}
      </div>
    </div>
  );
}

/** Syntax-highlighted source with line numbers.
 *
 *  The gutter is a separate column rather than per-line wrappers so the code stays ONE `<pre>` — which
 *  is what keeps select-and-copy giving you the code without a column of line numbers glued to it. */
function Code({ text, lang }: { text: string; lang?: string }) {
  const html = useMemo(() => {
    try { return lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang }).value : hljs.highlightAuto(text).value; }
    catch { return escapeHtml(text); }
  }, [text, lang]);
  const count = useMemo(() => (text ? text.split("\n").length : 0), [text]);
  if (!text) return <Empty label="Empty file" hint="0 bytes." />;
  return (
    <div className="flex min-h-full font-mono text-[11.5px] leading-[1.6]">
      <div aria-hidden className="shrink-0 select-none border-r border-white/[0.06] bg-black/20 px-2 py-2 text-right text-neutral-700">
        {Array.from({ length: count }, (_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <pre className="hljs min-w-0 flex-1 overflow-x-auto bg-transparent p-2"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  );
}

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));

/** CSV/TSV as a real table — the single biggest difference between "a marketer can use this" and
 *  "here are some commas". Parsed rather than split on `,` because a quoted field containing a comma
 *  is the normal case in exported data, not an edge case. */
function CsvTable({ text, tsv }: { text: string; tsv?: boolean }) {
  const rows = useMemo(() => parseDelimited(text, tsv ? "\t" : ","), [text, tsv]);
  if (!rows.length) return <Empty label="Empty" hint="No rows." />;
  const [head, ...body] = rows;
  // Capped: a 50k-row export would otherwise mount 50k <tr>s and lock the tab. The byte-level "load
  // more" still governs how much text is fetched; this governs how much is rendered.
  const shown = body.slice(0, 500);
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead className="sticky top-0 bg-neutral-900">
          <tr>{head.map((h, i) => <th key={i} className="border-b border-white/15 px-2 py-1 text-left font-semibold text-neutral-300">{h}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className="even:bg-white/[0.02]">
              {head.map((_, j) => <td key={j} className="border-b border-white/[0.06] px-2 py-1 align-top text-neutral-400">{r[j] ?? ""}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > shown.length && (
        <p className="px-2 py-1.5 text-[10px] text-neutral-600">showing {shown.length} of {body.length} rows</p>
      )}
    </div>
  );
}

/** Minimal RFC-4180: quoted fields, embedded delimiters/newlines, and "" as an escaped quote. */
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === delim) { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

/** Jupyter notebooks as cells. A notebook shown as raw JSON is unreadable, and it's the one format
 *  where the on-disk shape and the human-meaningful shape differ most. */
function Notebook({ text }: { text: string }) {
  const cells = useMemo(() => {
    try {
      const nb = JSON.parse(text) as { cells?: { cell_type?: string; source?: string[] | string; outputs?: unknown[] }[] };
      return (nb.cells || []).map((c) => ({
        type: c.cell_type === "markdown" ? "markdown" : "code",
        src: Array.isArray(c.source) ? c.source.join("") : String(c.source || ""),
        outputs: Array.isArray(c.outputs) ? c.outputs.length : 0,
      }));
    } catch { return null; }
  }, [text]);
  // A truncated slice of a big notebook is invalid JSON — say so honestly rather than rendering blank.
  if (!cells) return <Empty label="Couldn't parse this notebook" hint="It may be truncated — switch to source to see the raw JSON." />;
  if (!cells.length) return <Empty label="No cells" hint="" />;
  return (
    <div className="space-y-2 p-2">
      {cells.map((c, i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-white/10">
          <div className="flex items-center gap-2 border-b border-white/[0.07] bg-white/[0.03] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[.12em] text-neutral-500">
            <span>{c.type}</span>
            {c.outputs > 0 && <span className="ml-auto text-neutral-600">{c.outputs} output{c.outputs === 1 ? "" : "s"}</span>}
          </div>
          {c.type === "markdown"
            ? <div className="px-3 py-2 text-[12.5px]"><Markdown text={c.src} /></div>
            : <Code text={c.src} lang="python" />}
        </div>
      ))}
    </div>
  );
}
