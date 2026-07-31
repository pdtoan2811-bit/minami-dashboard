// Who is working in a task worktree — the question `bin/task.mjs` and the autopilot have always
// asked and never been able to answer.
//
// THE BUG THIS EXISTS FOR. `task.mjs` computed occupancy as `liveCwds().has(worktreeDir)`: the set of
// *session* cwds from /api/agent/live, tested against a *worktree* path. Every dashboard session's cwd
// is the project folder — the base checkout — because `bin/task.mjs new` creates a worktree but
// nothing ever moves a session into it. `~/.claude/projects/` contains no worktree-rooted directory at
// all, on a box that has been running this workflow for weeks. So that `.has()` could never return
// true, which made `task.mjs merge`'s `agent-live` refusal and the autopilot's `t.live === false` gate
// both unreachable: autopilot merged and deleted worktrees while agents were writing into them, twice
// in one morning. The guard wasn't miscomputed. The two sides spoke different vocabularies, and the
// answer to "is anyone working here?" was structurally always "no".
//
// TWO SIGNALS, DELIBERATELY, because each covers the other's blind spot:
//
//   cwd match   — authoritative while the dashboard is up, and it costs nothing to maintain because
//                 it's derived from the live session registry rather than stored. But it is blind for
//                 the first second or two of a brand-new chat (`liveActivity()` skips sessions with no
//                 `sessionId` yet) and it vanishes entirely when the server is restarting — which is
//                 precisely when a deploy-triggered autopilot tick is most likely to run.
//
//   claim file  — this module. Survives a server restart, covers the pre-sessionId window, and can be
//                 read with the dashboard completely down, which `task.mjs` has to support because
//                 working with the app off is one of its points.
//
// Neither alone is enough. A claim without a heartbeat is a lock nobody can unstick after a crash; a
// live-cwd check without a claim is amnesiac across the restart that causes the problem.
import fs from "node:fs";
import path from "node:path";

/** Lives in the worktree it describes, so removing the tree removes the claim — no orphan registry. */
export const CLAIM_FILE = ".minami-claim.json";

/** The directory `bin/task.mjs` creates worktrees under, relative to the repo root. */
export const TREES_DIR = ".minami-worktrees";

/**
 * How long a claim outlives its last heartbeat before it stops counting.
 *
 * Sized against the thing that actually goes wrong: the server is killed mid-turn by a deploy (see
 * manager.ts's restart-safety note), so no release is ever written. Too short and autopilot eats a
 * worktree whose owner is a few seconds from reattaching; too long and an abandoned tree is
 * un-mergeable until someone deletes a file by hand. Ten minutes covers a deploy plus a slow rebuild
 * with room to spare, and an owner that never comes back costs one extra autopilot cycle.
 */
export const CLAIM_TTL_MS = Math.max(60_000, Number(process.env.MINAMI_CLAIM_TTL_MS) || 10 * 60 * 1000);

export type Claim = {
  /** Task name — the worktree's directory name. Recorded so a stray file names what it belongs to. */
  task: string;
  /** The manager pane key that owns this tree. Two panes may legitimately share one; see `owners`. */
  owners: string[];
  /** Absolute worktree path, so a claim copied elsewhere is self-evidently not about that place. */
  cwd: string;
  claimedAt: number;
  /** Refreshed on every turn. Staleness is measured from here, never from `claimedAt`. */
  heartbeatAt: number;
};

const claimPath = (worktreeDir: string) => path.join(worktreeDir, CLAIM_FILE);

/**
 * Is this path inside a task worktree, and if so which one?
 *
 * Compares resolved paths. The registry stores what was typed while the CLI records what the OS
 * resolved, and on macOS `/tmp` → `/private/tmp` makes those two different strings for one directory
 * — the same trap that made agent history come back empty (§14.1). Returns the worktree ROOT, not the
 * file, so a session editing `<tree>/lib/x.ts` still claims `<tree>`.
 */
export function worktreeOf(p: string): { root: string; task: string } | null {
  if (!p) return null;
  // Parse FIRST, resolve second — and resolve only the worktree root.
  //
  // The obvious order (realpath the whole input, then parse) is wrong in a way that fails silently
  // toward "unoccupied". `realpathSync` throws when the final component doesn't exist, so a path to a
  // file an agent is about to CREATE falls back to the unresolved string while a path to one that
  // already exists comes back resolved — and on macOS those differ (`/tmp` → `/private/tmp`). The same
  // worktree then yields two different strings, `isOccupied`'s `===` misses, and the tree reads as
  // free. Caught by QA: `worktreeOf(<tree>)` and `worktreeOf(<tree>/lib/deep/new-file.ts)` disagreed.
  //
  // Resolving the root instead makes the answer independent of the leaf: a worktree root exists by
  // definition whenever the question is meaningful. Same trap as §14.1, where the registry stored a
  // typed path and the CLI recorded a resolved one, and an agent's history came back empty.
  const parts = path.resolve(p).split(path.sep);
  const i = parts.lastIndexOf(TREES_DIR);
  // Needs a name AFTER the trees dir: `.minami-worktrees` itself is not a worktree, and claiming it
  // would write a file into the parent of every task.
  if (i < 0 || i + 1 >= parts.length) return null;
  const raw = parts.slice(0, i + 2).join(path.sep);
  return { root: realpath(raw), task: parts[i + 1] };
}

/** Resolve symlinks, falling back to the input when the path is gone. Every path comparison in this
 *  module goes through it, so both sides of an `===` are always normalised the same way. */
function realpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

export function readClaim(worktreeDir: string): Claim | null {
  try {
    const raw = JSON.parse(fs.readFileSync(claimPath(worktreeDir), "utf8")) as Claim;
    if (!raw || typeof raw.heartbeatAt !== "number") return null;
    return { ...raw, owners: Array.isArray(raw.owners) ? raw.owners : [] };
  } catch {
    return null; // absent, unreadable, or truncated — all mean "no claim", never "throw"
  }
}

export function isFresh(c: Claim | null, now = Date.now()): boolean {
  return !!c && now - c.heartbeatAt < CLAIM_TTL_MS;
}

/**
 * Record that `key` is working in this tree, or refresh an existing claim's heartbeat.
 *
 * Additive in `owners`: two panes on one worktree is unusual but legal, and the second arriving must
 * not silently evict the first from the record that protects it. Write-then-rename, for the same
 * reason `preferred-account.ts` does it — a torn file reads as "no claim", which here means autopilot
 * deletes an occupied tree.
 *
 * Never throws. A worktree on a full disk should degrade to the cwd signal, not break the turn that
 * happened to trigger the heartbeat.
 */
export function touchClaim(cwd: string, key: string): void {
  const w = worktreeOf(cwd);
  if (!w) return; // not a worktree — the base checkout is nobody's exclusive property
  try {
    if (!fs.existsSync(w.root)) return; // being removed right now; don't recreate it as a bare file
    const now = Date.now();
    const prev = readClaim(w.root);
    const owners = prev?.owners?.includes(key) ? prev.owners : [...(prev?.owners || []), key];
    const next: Claim = {
      task: w.task,
      owners,
      cwd: w.root,
      claimedAt: prev?.claimedAt || now,
      heartbeatAt: now,
    };
    const tmp = `${claimPath(w.root)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, claimPath(w.root));
  } catch { /* disk, race with removal — the cwd signal still covers the live case */ }
}

/**
 * Drop `key` from the claim, and delete the file once nobody is left.
 *
 * Called on session close. Deliberately does NOT delete a claim that still lists other owners, and
 * deliberately does nothing if the file is already gone: `rm` on a worktree takes the claim with it,
 * so a close arriving afterwards must be a no-op rather than an error or a resurrection.
 */
export function releaseClaim(cwd: string, key: string): void {
  const w = worktreeOf(cwd);
  if (!w) return;
  try {
    const prev = readClaim(w.root);
    if (!prev) return;
    const owners = prev.owners.filter((o) => o !== key);
    if (!owners.length) { fs.rmSync(claimPath(w.root), { force: true }); return; }
    const tmp = `${claimPath(w.root)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...prev, owners }, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, claimPath(w.root));
  } catch { /* see touchClaim */ }
}

/** Absolute path of the repo's worktree directory, given the base checkout root. */
export const treesDirOf = (root: string) => path.join(root, TREES_DIR);

/** Every task worktree that currently exists, by name. */
export function listWorktrees(root: string): string[] {
  try {
    return fs.readdirSync(treesDirOf(root)).filter((d) => fs.existsSync(path.join(treesDirOf(root), d)));
  } catch {
    return [];
  }
}

/**
 * Is this worktree occupied — by a fresh claim, or by a live session whose cwd is inside it?
 *
 * `liveCwds` is passed in rather than fetched here so the same function answers for both callers: the
 * server (which has the registry in-process) and the CLI (which has to ask over HTTP and may get
 * nothing). Passing `null` means "couldn't ask" — and the result then rests on the claim file alone,
 * which is the entire reason it exists.
 */
export function isOccupied(worktreeDir: string, liveCwds: Set<string> | null, now = Date.now()): boolean {
  if (isFresh(readClaim(worktreeDir), now)) return true;
  if (!liveCwds) return false;
  // Normalise this side too. `worktreeOf` returns a resolved root, so comparing it against a raw
  // caller-supplied directory is the very mismatch documented above — one resolved, one not.
  const want = realpath(path.resolve(worktreeDir));
  for (const c of liveCwds) {
    const w = worktreeOf(c);
    if (w && w.root === want) return true;
  }
  return false;
}

/** Only for tests and the CLI's `--json`, which reports why a tree is considered busy. */
export function describeClaim(worktreeDir: string, now = Date.now()): { claimed: boolean; owners: string[]; ageMs: number | null } {
  const c = readClaim(worktreeDir);
  if (!c) return { claimed: false, owners: [], ageMs: null };
  return { claimed: isFresh(c, now), owners: c.owners, ageMs: now - c.heartbeatAt };
}

// Re-exported so the CLI's duplicated reader can be diffed against one authority if it ever drifts.
// `bin/task.mjs` is plain ESM and cannot import this TypeScript module without a build step, so it
// reads the same JSON by hand — the FILE FORMAT is the contract between them, not this code.
export const _CONTRACT = { CLAIM_FILE, TREES_DIR, fields: ["task", "owners", "cwd", "claimedAt", "heartbeatAt"] } as const;
