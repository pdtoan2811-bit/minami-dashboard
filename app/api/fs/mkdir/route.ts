import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { path: "<abs>" } → create the directory (recursively) so a new topic can have its own folder.
//
// Why this exists: `FolderPicker` could only ever BROWSE. There was no way to start a topic in a folder
// that didn't exist yet, and — worse — the picker happily let you select a non-existent path anyway,
// which produced a dead session (see the cwd check in api/agent/send). "Give this new topic its own
// folder" was simply not expressible in the UI.
//
// Trust boundary: same as `api/fs/list` (which reads any absolute path) and `api/agent/send` (whose
// `cwd` is unconfined, and whose agent can already write anywhere the process can). Bento is a local
// tool that is deliberately reachable from Thomas's own devices on his own network; the safety boundary
// is "don't expose this server to a network you don't trust", not a path allow-list here. This endpoint
// creates empty directories only — it cannot overwrite or delete anything — so it does not widen that
// boundary. If this server is ever bound to an untrusted network, that needs a real gate (auth) for
// every route at once, not a special case here.
export async function POST(req: Request) {
  try {
    const { path: raw } = await req.json();
    if (typeof raw !== "string" || !raw.trim()) {
      return Response.json({ error: "path is required" }, { status: 400 });
    }
    // Normalize first, THEN require absolute — so "/a/b/../../etc" can't smuggle a traversal past the
    // isAbsolute() check and land somewhere the caller didn't name.
    const dir = path.normalize(raw.trim());
    if (!path.isAbsolute(dir)) {
      return Response.json({ error: "path must be absolute" }, { status: 400 });
    }
    if (fs.existsSync(dir)) {
      // Already a directory → success (idempotent, so a double-click is harmless). Already a FILE → a
      // real conflict the user needs to know about, because mkdir would throw EEXIST either way and
      // "already exists" alone would be a confusing thing to report as an error.
      if (fs.statSync(dir).isDirectory()) return Response.json({ ok: true, path: dir, created: false });
      return Response.json({ error: "a file already exists at that path" }, { status: 400 });
    }
    fs.mkdirSync(dir, { recursive: true });
    return Response.json({ ok: true, path: dir, created: true });
  } catch (e) {
    // EACCES/EROFS/ENOTDIR land here. Pass the real message through — the picker shows it verbatim, and
    // "permission denied" is far more actionable than a generic failure.
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
