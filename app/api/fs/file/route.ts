import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Reads an arbitrary file for the file preview panel. Three modes on one path:
//
//   ?path=<abs>                  → { kind, mime, size, mtime, ... } + a slice of text when readable
//   ?path=<abs>&offset=&limit=   → the next slice (huge files are paged, never read whole)
//   ?path=<abs>&raw=1            → the bytes, for the types a browser renders natively (pdf, image)
//
// Same exposure argument as /api/fs/list and /api/fs/image: this is a loopback tool that already
// browses the filesystem and reads the whole of ~/.claude, and per CLAUDE.md it is deliberately NOT
// gated on Host or x-forwarded-for (both forgeable, neither proves locality). What IS narrowed here:
//
//   • text is served as a bounded SLICE, so a 2 GB log can be opened without the single-threaded
//     server reading it into memory — the cap is per request, not per file;
//   • `raw=1` is restricted to an allow-list of types a browser can display, so it can't be used as a
//     general "stream any file out of the process" endpoint;
//   • binary content is detected and refused rather than returned as mojibake.
//
// The size guard matters more than it looks: this server is shared by every open pane, so one careless
// read of a minified bundle or a package-manager cache file stalls every other request.

/** Per-request text budget. Big enough that ordinary source files arrive whole on the first request,
 *  small enough that a pathological file can't wedge the event loop. */
const TEXT_SLICE = 256 * 1024;
/** Nothing is streamed raw beyond this — a browser can't usefully show it anyway. */
const RAW_MAX = 25 * 1024 * 1024;
/** How much of the head is sniffed to decide text-vs-binary. */
const SNIFF = 8192;

const RAW_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
};

/** What the panel should RENDER with. Deliberately about presentation, not about file format purity:
 *  `.ipynb` is JSON on disk but a notebook to a human, and that distinction is the whole feature. */
export type FileKind = "code" | "markdown" | "notebook" | "csv" | "json" | "text" | "image" | "pdf" | "video" | "audio" | "binary";

const EXT_KIND: Record<string, FileKind> = {
  ".md": "markdown", ".mdx": "markdown", ".markdown": "markdown",
  ".ipynb": "notebook",
  ".csv": "csv", ".tsv": "csv",
  ".json": "json", ".jsonl": "json", ".geojson": "json",
  ".pdf": "pdf",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image", ".avif": "image", ".bmp": "image", ".ico": "image",
  ".mp4": "video", ".webm": "video", ".mov": "video",
  ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio",
  ".txt": "text", ".log": "text", ".env": "text", ".gitignore": "text", ".lock": "text",
};

// Anything here is shown with syntax highlighting. Kept as a list rather than "not in EXT_KIND" so an
// unknown extension degrades to plain text instead of being highlighted as the wrong language.
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh", ".bash", ".zsh", ".fish", ".sql", ".graphql",
  ".css", ".scss", ".less", ".html", ".htm", ".xml", ".yml", ".yaml", ".toml", ".ini", ".conf",
  ".dockerfile", ".makefile", ".vue", ".svelte", ".astro", ".r", ".lua", ".pl", ".dart", ".scala",
]);

/** Files with no extension that are still text, by convention. */
const NAMED_TEXT = new Set(["dockerfile", "makefile", "readme", "license", "changelog", "procfile", "gemfile", "rakefile", "brewfile"]);

function kindOf(p: string): FileKind {
  const ext = path.extname(p).toLowerCase();
  const base = path.basename(p).toLowerCase();
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  if (CODE_EXT.has(ext)) return "code";
  if (!ext && NAMED_TEXT.has(base)) return "text";
  if (base.startsWith(".")) return "text"; // dotfiles (.env.local, .eslintrc) are config text
  return ext ? "binary" : "text";
}

/** A NUL byte in the head is the same test `grep -I` and git use, and it is the right one: it costs a
 *  single small read and never mistakes UTF-8 prose for binary the way an entropy heuristic can. */
const looksBinary = (buf: Buffer) => buf.includes(0);

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const p = u.searchParams.get("path") || "";
    if (!p || !path.isAbsolute(p)) return Response.json({ error: "absolute path required" }, { status: 400 });

    const st = await fs.stat(p).catch(() => null);
    if (!st) return Response.json({ error: "not found" }, { status: 404 });
    if (st.isDirectory()) return Response.json({ error: "that's a directory" }, { status: 400 });
    if (!st.isFile()) return Response.json({ error: "not a regular file" }, { status: 400 });

    const kind = kindOf(p);
    const name = path.basename(p);
    const ext = path.extname(p).toLowerCase();

    // ---- raw bytes, for what the browser renders itself -------------------------------------
    if (u.searchParams.get("raw") === "1") {
      const mime = RAW_MIME[ext];
      // Allow-list rather than "guess a mime": an open-ended raw endpoint is a data-exfiltration
      // shape, and every type here is one a browser displays rather than downloads.
      if (!mime) return new Response("not a previewable binary type", { status: 400 });
      if (st.size > RAW_MAX) return new Response("too large to preview", { status: 413 });
      const buf = await fs.readFile(p);
      return new Response(new Uint8Array(buf), {
        headers: {
          "content-type": mime,
          // `inline` so a PDF opens in the embedded viewer instead of prompting a download.
          "content-disposition": `inline; filename="${encodeURIComponent(name)}"`,
          // NOT immutable: unlike a pasted screenshot, a source file changes under you — and a stale
          // preview of a file Claude just rewrote is precisely the wrong thing to show.
          "cache-control": "private, no-cache",
        },
      });
    }

    const meta = { path: p, name, kind, size: st.size, mtime: st.mtimeMs, ext };

    // Types the client fetches by URL (raw=1) rather than as JSON text.
    if (kind === "image" || kind === "pdf" || kind === "video" || kind === "audio") {
      return Response.json({ ...meta, servedRaw: true });
    }

    const fh = await fs.open(p, "r");
    try {
      // Sniff the head before committing to reading a slice — a mislabelled `.txt` that is really a
      // binary blob must not reach the client as replacement characters.
      const head = Buffer.alloc(Math.min(SNIFF, st.size));
      if (head.length) await fh.read(head, 0, head.length, 0);
      if (looksBinary(head)) return Response.json({ ...meta, kind: "binary" as FileKind, binary: true });

      const offset = Math.max(0, Number(u.searchParams.get("offset")) || 0);
      const limit = Math.min(TEXT_SLICE, Math.max(1024, Number(u.searchParams.get("limit")) || TEXT_SLICE));
      const end = Math.min(st.size, offset + limit);
      const len = Math.max(0, end - offset);
      const buf = Buffer.alloc(len);
      if (len) await fh.read(buf, 0, len, offset);

      // A slice can land mid-codepoint and mid-line. Trimming back to the last newline keeps every
      // rendered line whole and makes `nextOffset` a clean boundary for the following request — so
      // paging never splits a line of code across two fetches.
      let text = buf.toString("utf8");
      let nextOffset = end;
      if (end < st.size) {
        const cut = text.lastIndexOf("\n");
        if (cut > 0) { nextOffset = offset + Buffer.byteLength(text.slice(0, cut + 1), "utf8"); text = text.slice(0, cut + 1); }
      }

      return Response.json({
        ...meta,
        text,
        offset,
        nextOffset: nextOffset < st.size ? nextOffset : null,
        truncated: nextOffset < st.size,
        // Only meaningful for the slice actually returned — the client shows "lines 1–N of a big file"
        // rather than claiming a total it would have to read the whole file to know.
        lines: text.length ? text.split("\n").length : 0,
      });
    } finally {
      await fh.close();
    }
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
