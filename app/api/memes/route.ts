// WHAT MEMES EXIST — read off disk, once per page load.
//
// The cut-scene folders are collected by hand and change between meetings, so the client cannot hold
// a hardcoded list. This route reads them and returns the URLs the browser can play.
//
// ⚠️ NOT AUTHENTICATED, and that is correct: everything here is already publicly served from
// `public/`, so the listing exposes nothing the files themselves do not. It is also read-only and
// touches no meeting data.
//
// Serves from public/memes/<moment>/<file>. The folder IS the taxonomy — nothing parses filenames.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-dynamic";

const ROOT = join(process.cwd(), "public", "memes");
/** GIF is what anh collects. The others cost nothing to allow and stop a stray png being invisible. */
const PLAYABLE = /\.(gif|png|jpe?g|webp|avif)$/i;

export async function GET() {
  const out: Record<string, string[]> = {};
  let dirs: string[] = [];
  try {
    dirs = readdirSync(ROOT).filter((d) => {
      // `_unsorted` is a staging area, deliberately never played — a meme in there has not been
      // judged to fit any moment yet, and a tonally wrong image on a real moment is the one failure
      // this feature cannot afford.
      if (d.startsWith("_") || d.startsWith(".")) return false;
      try { return statSync(join(ROOT, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    // No folder at all is a legitimate state — every moment simply falls back to the emoji scene.
    return Response.json({ ok: true, memes: {} });
  }
  for (const d of dirs) {
    try {
      const files = readdirSync(join(ROOT, d)).filter((f) => PLAYABLE.test(f));
      if (files.length) out[d] = files.map((f) => `/memes/${encodeURIComponent(d)}/${encodeURIComponent(f)}`);
    } catch { /* an unreadable folder is an empty one */ }
  }
  return Response.json({ ok: true, memes: out });
}
