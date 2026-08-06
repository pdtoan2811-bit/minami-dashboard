// Isolating a chat — the last mile of the worktree workflow.
//
// `bin/task.mjs` has been able to create worktrees for weeks, and `lib/worktree-claim.ts` and the
// autopilot have been able to track and merge them for nearly as long. None of it was ever used,
// because the one step in the middle was manual: you had to leave the dashboard, run a CLI, and then
// point a pane at the folder it printed. §9 records the consequence — `~/.claude/projects/` contained
// no worktree-rooted directory at all, so the occupancy gate that guards those worktrees had, in its
// entire life, never once evaluated true.
//
// This module is that middle step, so the dashboard can do it at the only moment it matters: when a
// second chat is about to start in a folder that already has one. Two facts make it the dashboard's
// job and nobody else's:
//
//   · **A session's cwd is fixed at spawn.** Nothing can move a conversation that is already running,
//     so isolation is a decision taken before the first message or not at all. The autopilot ticks on
//     a timer and cannot see that moment; only the thing creating the pane can.
//   · **The dashboard is the only process that can see both chats.** git can't, the SDK can't, and
//     neither agent can see the other.
//
// Two backends, one interface. A repo carrying `bin/task.mjs` (this one) delegates to it, so ports,
// the node_modules link, the merge gates and the autopilot's view of the world all stay defined in
// exactly one place — the same reason `list` and `merge` grew `--json` rather than being scraped. Any
// other git repo gets a plain `git worktree`, which is enough for isolation and for the manual merge
// button; the autopilot deliberately stays out of repos it has no gates for.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { TREES_DIR, worktreeOf } from "./worktree-claim";

const exec = promisify(execFile);

/** Off by default while it is new. Every knob in this app is an env var and `.env.example` is the
 *  complete list; this one is read on the SERVER only, so the switch has exactly one home and a
 *  client can never disagree with it about whether isolation is on. */
export const AUTO_ISOLATE = process.env.MINAMI_AUTO_ISOLATE !== "0";

export type Isolated = { name: string; dir: string; branch: string; base: string; port?: number };

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "chat";

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 8 << 20 });
  return stdout.trim();
}

/**
 * What kind of place is this, from git's point of view?
 *
 * `--show-toplevel` is the checkout you are standing in; `--git-common-dir` points every worktree at
 * the ONE real `.git`, so its parent is the base checkout. Equal → you are in the base. Different →
 * you are already in a worktree, and isolating again would nest task trees inside task trees.
 */
export async function repoInfo(cwd: string): Promise<{ root: string; base: string; isWorktree: boolean; hasTaskCli: boolean } | null> {
  try {
    const root = await git(["rev-parse", "--show-toplevel"], cwd);
    if (!root) return null;
    const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
    const base = path.dirname(common);
    return {
      root,
      base,
      isWorktree: path.resolve(root) !== path.resolve(base),
      hasTaskCli: fs.existsSync(path.join(base, "bin", "task.mjs")),
    };
  } catch {
    // Not a repo, or no git. Both mean "there is nothing to isolate", which is not an error — most
    // folders someone opens a chat in are not checkouts.
    return null;
  }
}

/** A name that reads like the work, stays unique, and survives being a branch name and a folder name.
 *  The suffix is not decoration: two panes opened on the same topic within a second would otherwise
 *  collide, and `task new` refuses an existing directory rather than silently reusing it. */
function nameFor(label: string, taken: Set<string>): string {
  const stem = slug(label);
  if (!taken.has(stem)) return stem;
  for (let i = 2; i < 100; i++) { const n = `${stem}-${i}`; if (!taken.has(n)) return n; }
  return `${stem}-${Date.now().toString(36).slice(-4)}`;
}

function existingNames(base: string): Set<string> {
  try { return new Set(fs.readdirSync(path.join(base, TREES_DIR), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)); }
  catch { return new Set(); }
}

/**
 * Give this chat its own checkout. Returns null when isolation doesn't apply — not a repo, already in
 * a worktree, or switched off — because "carry on in the shared folder" is a normal answer and callers
 * should not have to distinguish it from a failure.
 */
export async function isolate(cwd: string, label: string): Promise<Isolated | null> {
  if (!AUTO_ISOLATE) return null;
  const info = await repoInfo(cwd);
  if (!info || info.isWorktree) return null;

  const name = nameFor(label, existingNames(info.base));

  if (info.hasTaskCli) {
    const { stdout } = await exec(process.execPath, [path.join(info.base, "bin", "task.mjs"), "new", name, "--json"], { cwd: info.base, maxBuffer: 8 << 20 });
    const r = JSON.parse(stdout.trim().split("\n").pop() || "{}");
    if (!r?.ok) throw new Error(r?.error || "task.mjs new failed");
    return { name: r.name, dir: r.dir, branch: r.branch, base: r.base, port: r.port };
  }

  // Plain-git fallback. Deliberately minimal: a branch, a checkout, and the node_modules link, which
  // is the difference between a folder an agent can work in and one where every `npm` command fails.
  const from = await git(["rev-parse", "--abbrev-ref", "HEAD"], info.base);
  const dir = path.join(info.base, TREES_DIR, name);
  const branch = `task/${name}`;
  fs.mkdirSync(path.join(info.base, TREES_DIR), { recursive: true });
  await git(["worktree", "add", "-b", branch, dir, from], info.base);
  await git(["config", "minami.base", from], dir);
  const mods = path.join(info.base, "node_modules");
  if (fs.existsSync(mods) && !fs.existsSync(path.join(dir, "node_modules"))) {
    try { fs.symlinkSync(mods, path.join(dir, "node_modules"), "dir"); } catch { /* optional */ }
  }
  return { name, dir, branch, base: from };
}

/**
 * Fold the work back into the base branch. `task.mjs merge` where it exists, because that is where the
 * gates live (clean task, clean base, nobody working in it, a build that passes) and re-deriving them
 * here would be a second definition of "ready" — and the one that drifts is always the automated one
 * nobody watches. Elsewhere, a plain no-ff merge; the caller reports whatever git says.
 */
export async function mergeBack(dir: string): Promise<{ ok: boolean; message: string }> {
  const wt = worktreeOf(dir);
  if (!wt) return { ok: false, message: "not an isolated chat" };
  const base = path.resolve(dir, "..", "..");
  const cli = path.join(base, "bin", "task.mjs");

  if (fs.existsSync(cli)) {
    try {
      const { stdout } = await exec(process.execPath, [cli, "merge", wt.task, "--json"], { cwd: base, maxBuffer: 16 << 20 });
      const r = JSON.parse(stdout.trim().split("\n").pop() || "{}");
      return { ok: !!r?.ok, message: r?.error || r?.reason || (r?.ok ? `merged ${wt.task}` : "merge refused") };
    } catch (e) {
      return { ok: false, message: String((e as Error)?.message || e) };
    }
  }
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
    await git(["merge", "--no-ff", branch, "-m", `merge ${branch}`], base);
    return { ok: true, message: `merged ${branch}` };
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message || e) };
  }
}

/**
 * Drop a worktree that was never used. An auto-created tree is a guess about what a chat was going to
 * do, and a guess that turns out wrong should cost nothing — a pane opened, never written in, and
 * closed leaves a checkout and a branch behind forever otherwise. "Never used" is strict on purpose:
 * no commits ahead of its base AND nothing uncommitted. Anything else is someone's work.
 */
export async function discardIfPristine(dir: string): Promise<boolean> {
  const wt = worktreeOf(dir);
  if (!wt || !fs.existsSync(dir)) return false;
  const base = path.resolve(dir, "..", "..");
  try {
    const dirty = (await git(["status", "--porcelain"], dir)).trim();
    if (dirty) return false;
    const from = (await git(["config", "--get", "minami.base"], dir).catch(() => "")) || "main";
    const ahead = (await git(["rev-list", "--count", `${from}..HEAD`], dir)).trim();
    if (ahead !== "0") return false;
    const cli = path.join(base, "bin", "task.mjs");
    if (fs.existsSync(cli)) await exec(process.execPath, [cli, "rm", wt.task, "--force"], { cwd: base, maxBuffer: 8 << 20 });
    else {
      await git(["worktree", "remove", "--force", dir], base);
      await git(["branch", "-D", `task/${wt.task}`], base).catch(() => "");
    }
    return true;
  } catch {
    return false;
  }
}
