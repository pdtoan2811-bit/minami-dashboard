// Is a task's work merged and in the live build? Asked of git, not of the chat (§37).
//
// Thomas, 2026-10-29: "task are waiting to merge with each other and feel like everything is waiting for
// each other". Of five Waiting tasks, three were already merged and live: autopilot or another chat had
// merged their branch, nobody told the task, and its card kept asking "Merge and deploy the tile layout
// fix?". Haiku reads only the END of the task's own chat, so a merge done elsewhere is invisible to it.
// Git sees it from anywhere.
//
// Only this repo's task worktrees (`.minami-worktrees/<name>`), because only here can "live" be checked:
// the live build is `.next/BUILD_ID` in the server's own checkout. The main checkout itself is never
// asked — its HEAD is always in main, so it would read as shipped before anything was done.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TREES = path.join(ROOT, ".minami-worktrees") + path.sep;

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }).trim();

const asked = new Map<string, { at: number; ok: boolean }>();

/** True when the tree at `cwd` is clean, has commits of its own, they are in main, and the live build was
 *  made after they landed there. Cached a minute per tree: `ensure` runs on every board poll. */
export function shippedLive(cwd: string): boolean {
  if (!cwd.startsWith(TREES)) return false;
  const hit = asked.get(cwd);
  if (hit && Date.now() - hit.at < 60e3) return hit.ok;
  let ok = false;
  try {
    if (!git(cwd, "status", "--porcelain")) {
      const head = git(cwd, "rev-parse", "HEAD");
      const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
      // Where the branch was cut. A tree that never committed has HEAD there, and HEAD is then trivially in
      // main — which says nothing was shipped, only that nothing was made.
      const born = git(ROOT, "reflog", "show", "--format=%H", `refs/heads/${branch}`).split("\n").pop();
      if (born && born !== head) {
        execFileSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", head, "main"], { stdio: "ignore", timeout: 4000 });
        // When it reached main: the first main commit that contains it (the merge), or HEAD itself if
        // main fast-forwarded onto it.
        const via = git(ROOT, "rev-list", "--ancestry-path", "--reverse", `${head}..main`).split("\n")[0] || head;
        const landed = Number(git(ROOT, "show", "-s", "--format=%ct", via)) * 1000;
        ok = statSync(path.join(ROOT, ".next", "BUILD_ID")).mtimeMs > landed;
      }
    }
  } catch { ok = false; } // not an ancestor, no reflog, no build: not shown shipped
  asked.set(cwd, { at: Date.now(), ok });
  return ok;
}

const blocks = new Map<string, { at: number; v: string | null }>();

/** What stops a finished task tree from merging that is NOT its own doing, or null. Today that is one case,
 *  the one that cost 2026-10-29: the tree is committed and clean, but the main checkout holds another chat's
 *  unsaved file, so `task.mjs merge` refuses every merge until someone commits it. Returns the files. */
export function mergeBlock(cwd: string): string | null {
  if (!cwd.startsWith(TREES)) return null;
  const hit = blocks.get(cwd);
  if (hit && Date.now() - hit.at < 60e3) return hit.v;
  let v: string | null = null;
  try {
    if (!git(cwd, "status", "--porcelain")) {
      const head = git(cwd, "rev-parse", "HEAD");
      const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
      const born = git(ROOT, "reflog", "show", "--format=%H", `refs/heads/${branch}`).split("\n").pop();
      let merged = true;
      try { execFileSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", head, "main"], { stdio: "ignore", timeout: 4000 }); } catch { merged = false; }
      if (born && born !== head && !merged) {
        // Not through `git()`: its trim eats the first line's leading status space (" M a.txt"), which
        // shifted the fixed-width slice and named the file ".txt" (caught in a scratch repo, 2026-10-29).
        const dirt = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", timeout: 4000 })
          .split("\n").filter(Boolean).map((l) => l.slice(3));
        if (dirt.length) v = dirt.slice(0, 2).map((f) => path.basename(f)).join(", ") + (dirt.length > 2 ? ` +${dirt.length - 2}` : "");
      }
    }
  } catch { v = null; }
  blocks.set(cwd, { at: Date.now(), v });
  return v;
}
