import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /inspect.js — the one line a previewed app includes in development (§21).
//
// Two files concatenated at request time rather than one prebuilt bundle: `html-to-image`'s UMD build
// (it exposes a `htmlToImage` global, which is all the core script needs for crops) followed by
// `public/inspect-core.js`, the protocol implementation. No build step means the script can be
// edited and reloaded like any static file.
//
// The vendor is a checked-in copy under public/vendor, NOT read from node_modules — deliberately.
// Nothing in this box's pipeline installs: `task.mjs merge` and `deploy.sh` build and swap, worktrees
// share nothing but git objects (§9), and the first version of this route read node_modules and would
// have shipped a production server whose every crop came back null until someone ran npm by hand.
// Still optional: if the file is ever missing the script loads without it, and only crops are lost.
const VENDOR = path.join(process.cwd(), "public", "vendor", "html-to-image.js");
const CORE = path.join(process.cwd(), "public", "inspect-core.js");

let cache: { body: string; at: number } | null = null;
const CACHE_MS = 5_000;

export async function GET() {
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      const [vendor, core] = await Promise.all([
        fs.readFile(VENDOR, "utf8").catch(() => "/* public/vendor/html-to-image.js missing — crops disabled */\n"),
        fs.readFile(CORE, "utf8"),
      ]);
      cache = { body: `${vendor}\n;\n${core}`, at: Date.now() };
    }
    return new Response(cache.body, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        // A <script src> needs no CORS, but a fetch()-based loader in some app might — and this file
        // has nothing to protect: it is public, static and served only on loopback.
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return new Response(`/* inspect.js unavailable: ${String((e as Error)?.message || e)} */`, {
      status: 500, headers: { "content-type": "application/javascript; charset=utf-8" },
    });
  }
}
