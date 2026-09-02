import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST <raw bytes>, header `x-filename: <name>` → { path }
//
// The FALLBACK half of drag-and-drop, and it is worth being precise about when it runs.
//
// A file dragged out of Finder already exists on this machine, so the right result is its own path —
// no copy, edits land on the real file. Chrome sometimes puts that path in the drag's `text/uri-list`,
// in which case the client uses it directly and never calls this route (see Composer.tsx). When it
// doesn't, the only thing the browser will part with is the bytes, and this is where they land.
//
// So a dropped file can become EITHER a reference or a copy depending on what the browser felt like
// disclosing. That is not a nice property, and it is exactly why the native picker
// (/api/fs/choose) exists alongside it: that path is always a reference, never a copy.
//
// Destination is ~/.minami, not the session's cwd — same reasoning as /api/fs/paste, which this is
// modelled on: the dashboard drops into every topic's folder and cannot edit their .gitignores, and a
// dropped file is chat input rather than a project artifact.
const ROOT = process.env.MINAMI_DROPS || path.join(os.homedir(), ".minami", "drops");
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Reduce a client-supplied filename to something that cannot escape ROOT or surprise a shell.
 *
 * `path.basename` alone is not enough: the name is also going to be pasted into a chat message as part
 * of a path, so a newline or a quote in it would break the composer's path regex (lib/agent/images.ts)
 * rather than just being ugly. Anything outside a conservative set becomes `_`, and the extension is
 * preserved separately because that is what decides whether the send route inlines it as an image.
 */
function safeName(raw: string): string {
  // The client percent-encodes the name because an HTTP header value cannot carry a space or anything
  // non-ASCII, and a filename routinely has both. Decoding here is not optional cleanup: skipped, the
  // literal "%20" reaches the sanitiser below, whose `%` is not in the allowed set — so "my notes.ts"
  // is written to disk as "my_20notes.ts". Malformed input keeps the raw value rather than throwing.
  let name = String(raw || "").trim();
  try { name = decodeURIComponent(name); } catch { /* not valid percent-encoding — take it as-is */ }
  const base = path.basename(name) || "drop";
  const ext = path.extname(base).slice(0, 12).replace(/[^A-Za-z0-9.]/g, "");
  const stem = base.slice(0, base.length - path.extname(base).length).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "drop";
  return stem + ext;
}

export async function POST(req: Request) {
  try {
    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length === 0) return Response.json({ error: "empty body" }, { status: 400 });
    if (buf.length > MAX_BYTES) return Response.json({ error: `file too large (max ${MAX_BYTES / 1024 / 1024}MB)` }, { status: 413 });

    await fs.mkdir(ROOT, { recursive: true });
    // The random segment is not decoration: two panes can drop files with the same name in the same
    // millisecond, and silently overwriting one with the other would attach the wrong file to a chat.
    const dir = path.join(ROOT, `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString("hex")}`);
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, safeName(req.headers.get("x-filename") || "drop"));
    await fs.writeFile(dest, buf);
    void prune();
    return Response.json({ path: dest, bytes: buf.length });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

// Dropped files are chat input with no long-term value, and unlike pastes they can be tens of MB. Age
// them out on write so this directory can't grow without bound; failures are ignored because a failed
// tidy must never fail the drop that triggered it.
async function prune() {
  try {
    const now = Date.now();
    for (const name of await fs.readdir(ROOT)) {
      const p = path.join(ROOT, name);
      try {
        const st = await fs.stat(p);
        if (now - st.mtimeMs > MAX_AGE_MS) await fs.rm(p, { recursive: true, force: true });
      } catch { /* raced with another prune, or vanished */ }
    }
  } catch { /* ROOT missing — nothing to prune */ }
}
