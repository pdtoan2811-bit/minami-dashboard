import fs from "node:fs/promises";
import path from "node:path";
import { IMAGE_MIME, looksLikeImage } from "@/lib/agent/images";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET ?path=<absolute image path> → the image bytes, for thumbnails in the composer and transcript.
//
// This serves an arbitrary absolute path, which is a wider door than /api/agent/browser/file (pinned
// to `<cwd>/.playwright-mcp`), so the narrowing is worth stating:
//   • the extension must be an image type AND the header bytes must agree — a renamed .env or an
//     id_rsa cannot be coaxed through, because neither has a PNG/JPEG/GIF/WebP magic number;
//   • there is a size cap, so this can't be used to stream something enormous out of the process.
//
// Within those limits the exposure matches what Bento already is: a loopback tool that browses the
// filesystem via /api/fs/list and reads the whole of ~/.claude. Per CLAUDE.md this is NOT gated on
// Host or x-forwarded-for — both are forgeable and neither proves locality.
const MAX_BYTES = 10 * 1024 * 1024;

export async function GET(req: Request) {
  try {
    const p = new URL(req.url).searchParams.get("path") || "";
    if (!p || !path.isAbsolute(p)) return new Response("bad path", { status: 400 });
    const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
    if (!mime) return new Response("not an image type", { status: 400 });

    const st = await fs.stat(p).catch(() => null);
    if (!st || !st.isFile()) return new Response("not found", { status: 404 });
    if (st.size > MAX_BYTES) return new Response("too large", { status: 413 });

    const buf = await fs.readFile(p);
    if (!looksLikeImage(buf)) return new Response("not an image", { status: 400 });

    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": mime,
        // Pasted files are immutable once written (the name carries a timestamp + random suffix), so
        // the thumbnail can be cached hard. Private: this is someone's screen, not a public asset.
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (e) {
    return new Response(String((e as Error)?.message || e), { status: 500 });
  }
}
