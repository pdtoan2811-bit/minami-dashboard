import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Serves the artifacts Playwright MCP already writes to `<session cwd>/.playwright-mcp/` — full-resolution
// screenshots, the `page-*.yml` accessibility snapshot, and `console-*.log`.
//
// Why this exists rather than leaning on the base64 in the transcript:
//   • The inline image is downscaled server-side (≤1568px/side) before it's ever base64'd, and is
//     stripped from sessionStorage by `trimOutput` (app/page.tsx:69) — so a hard reload loses the pixels
//     entirely. The file on disk is full-res and permanent for the life of the session's cwd.
//   • An action result only ever reports console *counts* ("- Console: 1 errors, 0 warnings"). The
//     actual console text is in `console-*.log`. Reading it here is what lets the panel show real
//     console output without spending a turn asking the agent for it.
//
// Access rules: `file` must be a bare filename of an expected type (no slashes, no dots-dots — the regex
// alone forbids traversal), and the resolved path must still land inside `<cwd>/.playwright-mcp` after
// normalization. Bento is a localhost tool that already reads the user's whole ~/.claude, so `cwd` comes
// from the client; the point of these checks is to keep this route from widening that into an arbitrary
// file reader.

const SAFE_NAME = /^[A-Za-z0-9._-]+\.(png|jpe?g|ya?ml|log|webm)$/i;
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  yml: "text/plain; charset=utf-8", yaml: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8", webm: "video/webm",
};

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const cwd = searchParams.get("cwd") || "";
    const file = searchParams.get("file") || "";
    if (!cwd || !path.isAbsolute(cwd)) return new Response("bad cwd", { status: 400 });
    if (!SAFE_NAME.test(file)) return new Response("bad file", { status: 400 });

    const dir = path.join(cwd, ".playwright-mcp");
    const full = path.resolve(dir, file);
    // Belt-and-braces: SAFE_NAME already rules out separators, but a symlinked/odd `dir` shouldn't be
    // able to escape either.
    if (full !== path.join(dir, file)) return new Response("bad path", { status: 400 });

    const body = await readFile(full);
    const ext = file.split(".").pop()!.toLowerCase();
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": MIME[ext] || "application/octet-stream",
        // Filenames are timestamped by Playwright, so a hit is always the same bytes. The one exception
        // is an explicit `filename` the agent reused — no-cache would cost a refetch on every hover of
        // the filmstrip, so accept that and let a reload fix it.
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // A missing file is the normal case, not an error: the agent may have run with a different cwd, or
    // the directory may have been cleaned. The client falls back to the inline base64.
    if (err?.code === "ENOENT") return new Response("not found", { status: 404 });
    return new Response(String(err?.message || e), { status: 500 });
  }
}
