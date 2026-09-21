import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /inspect.js — the one line a previewed app includes in development (§21).
//
// Two files concatenated at request time rather than one prebuilt bundle: `html-to-image`'s UMD build
// straight out of node_modules (it exposes a `htmlToImage` global, which is all the core script needs
// for crops) followed by `public/inspect-core.js`, the protocol implementation. No build step means
// the script can be edited and reloaded like any static file, and the vendor stays a normal
// dependency instead of a checked-in copy that drifts.
//
// The vendor is optional on purpose. A checkout that hasn't run `npm install` since this landed
// (worktrees share nothing but git objects — §9) still gets a working script: pins, component
// chains, errors and anchoring all work, and only the crop comes back null. That degrades to the
// selector-only message rather than a broken preview.
const VENDOR = path.join(process.cwd(), "node_modules", "html-to-image", "dist", "html-to-image.js");
const CORE = path.join(process.cwd(), "public", "inspect-core.js");

let cache: { body: string; at: number } | null = null;
const CACHE_MS = 5_000;

export async function GET() {
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      const [vendor, core] = await Promise.all([
        fs.readFile(VENDOR, "utf8").catch(() => "/* html-to-image not installed — crops disabled */\n"),
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
