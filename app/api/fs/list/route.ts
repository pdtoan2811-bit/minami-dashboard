import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/fs/list?path=<abs> → list sub-directories, for the "start a chat in a folder" picker.
// Local-only (reads the machine's filesystem). Defaults to the home directory. Also flags whether the
// folder is a git repo / has a package.json, so the picker can hint which folders are real projects.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const qp = u.searchParams.get("path");
  const withFiles = u.searchParams.get("files") === "1";
  const dir = qp && path.isAbsolute(qp) ? qp : os.homedir();
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
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
    return Response.json({ path: dir, parent: parent === dir ? null : parent, home: os.homedir(), dirs, files });
  } catch (e) {
    return Response.json({ path: dir, parent: null, home: os.homedir(), dirs: [], files: [], error: String((e as Error)?.message || e) }, { status: 200 });
  }
}
