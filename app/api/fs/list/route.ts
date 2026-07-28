import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/fs/list?path=<abs> → list sub-directories, for the "start a chat in a folder" picker.
// Local-only (reads the machine's filesystem). Defaults to the home directory. Also flags whether the
// folder is a git repo / has a package.json, so the picker can hint which folders are real projects.
//
// Deliberately UNCONFINED: `path` accepts any absolute path on the machine, and this dashboard is meant
// to be reachable from other devices on Thomas's own network (e.g. his phone, per the project's own
// "mobile-first" design goal) — adding a loopback/host check here would break that intended use case.
// The actual safety boundary is "don't expose this server beyond a network you trust" (same assumption
// `agent/send`'s unconfined `cwd` and the live-drive agent itself already make — it can read/write
// anywhere the process can). If this server is ever bound to a public/untrusted network, that decision
// needs its own gate (auth, or a real path allow-list) — not something to bolt on here silently.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const qp = u.searchParams.get("path");
  const withFiles = u.searchParams.get("files") === "1";
  const dir = qp && path.isAbsolute(qp) ? qp : os.homedir();
  try {
    const all = fs.readdirSync(dir, { withFileTypes: true });
    // Cap the number of entries that get the (synchronous, 2-stat-per-entry) git/package.json probe
    // below. Unlike the confined `path` param above, this IS worth bounding — this server is single-
    // threaded and shared by every open pane, and nothing stops a user from navigating into a directory
    // with thousands of entries (a package-manager cache, Downloads, a large media folder) and stalling
    // every other request for the length of the scan. Mirrors the existing cap in bento/attach-batch.
    const truncated = all.length > 2000;
    const entries = truncated ? all.slice(0, 2000) : all;
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => {
        const full = path.join(dir, e.name);
        let git = false, pkg = false;
        try { git = fs.existsSync(path.join(full, ".git")); } catch { /* perm */ }
        try { pkg = fs.existsSync(path.join(full, "package.json")); } catch { /* perm */ }
        return { name: e.name, path: full, git, pkg };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = withFiles
      ? entries.filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => ({ name: e.name, path: path.join(dir, e.name) })).sort((a, b) => a.name.localeCompare(b.name))
      : [];
    const parent = path.dirname(dir);
    return Response.json({ path: dir, parent: parent === dir ? null : parent, home: os.homedir(), dirs, files, truncated });
  } catch (e) {
    return Response.json({ path: dir, parent: null, home: os.homedir(), dirs: [], files: [], error: String((e as Error)?.message || e) }, { status: 200 });
  }
}
