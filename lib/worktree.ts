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
import os from "node:os";
import path from "node:path";
import { isFresh, readClaim, TREES_DIR, worktreeOf } from "./worktree-claim";

const exec = promisify(execFile);

/** Off by default while it is new. Every knob in this app is an env var and `.env.example` is the
 *  complete list; this one is read on the SERVER only, so the switch has exactly one home and a
 *  client can never disagree with it about whether isolation is on. */
export const AUTO_ISOLATE = process.env.MINAMI_AUTO_ISOLATE !== "0";

/** The checkout this server runs from — `git rev-parse` is async, and this is needed on a hot path, so
 *  it is walked once here. A worktree preview server resolves to the base via the `.git` FILE it
 *  carries (a worktree's `.git` is a pointer, not a directory), so previews are covered too. */
const OWN_BASE = (() => {
  let d = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, ".git"))) {
      try {
        const g = fs.statSync(path.join(d, ".git"));
        if (g.isDirectory()) return d;
        // A worktree: `.git` is a file pointing at <base>/.git/worktrees/<name>.
        const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(path.join(d, ".git"), "utf8"));
        const wt = m?.[1]?.trim();
        const idx = wt ? wt.indexOf("/.git/worktrees/") : -1;
        if (idx > 0) return wt!.slice(0, idx);
        return d;
      } catch { return d; }
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return process.cwd();
})();

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

/**
 * Names already spoken for — **directories and branches both**.
 *
 * Listing only directories was a real hazard rather than an oversight: `task new` adds a worktree onto
 * an EXISTING branch when it finds one, so a leftover `task/chat` (a hand-removed tree, or an `rm` that
 * kept the branch) meant the next auto-isolated chat silently started on somebody's old commits and
 * would have merged them back on the first "merge back" click.
 */
async function takenNames(base: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    for (const d of fs.readdirSync(path.join(base, TREES_DIR), { withFileTypes: true })) {
      if (d.isDirectory()) out.add(d.name);
    }
  } catch { /* no trees dir yet */ }
  try {
    const listed = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/task"], base);
    for (const ref of listed.split("\n")) { const n = ref.trim().replace(/^task\//, ""); if (n) out.add(n); }
  } catch { /* not a repo, or no task branches */ }
  return out;
}

/**
 * Is this the repo the dashboard itself is running from?
 *
 * The `task.mjs` backend executes a script *out of the repository being isolated*, and the repo is
 * named by the client (`/api/worktree` takes a cwd). Any checkout on this machine that happens to
 * carry a `bin/task.mjs` would otherwise be run by the server on a client's say-so. Confining the CLI
 * path to our own tree keeps that to a script we ship; every other repo gets the plain-git backend,
 * which runs nothing but `git`.
 */
function isOwnRepo(base: string): boolean {
  try { return path.resolve(fs.realpathSync(base)) === path.resolve(fs.realpathSync(OWN_BASE)); }
  catch { return false; }
}

/**
 * Give this chat its own checkout. Returns null when isolation doesn't apply — not a repo, already in
 * a worktree, or switched off — because "carry on in the shared folder" is a normal answer and callers
 * should not have to distinguish it from a failure.
 */
/**
 * How a repo wants isolation to behave — `git config minami.isolate` in the repo itself.
 *
 * A git config rather than an env list because the decision belongs to the REPO: it travels with
 * the checkout, needs no server restart, and a session standing in the folder can set it itself.
 *
 *  · **eager** (unset, the default) — every overlapping blank chat gets a worktree at birth. Right
 *    for code, where parallel edits collide and the first write can land seconds into turn one.
 *  · **lazy** — chats share the checkout until one actually WRITES a file here while another chat
 *    is present; only then does it earn a tree (the placement pass, §3/§9, does the move at the
 *    next turn boundary). Right for a context-first folder like the vault: most chats born there
 *    only read it, and 2026-09-02's pile-up was worktrees created for chats that never wrote one
 *    vault file — plus a vault compaction running invisibly in a tree nobody merged.
 *  · **off** — never isolate here, regardless of contention.
 */
export type IsolateMode = "eager" | "lazy" | "off";
export async function isolateMode(base: string): Promise<IsolateMode> {
  try {
    const v = (await git(["config", "--get", "minami.isolate"], base)).trim();
    if (v === "off") return "off";
    if (v === "lazy") return "lazy";
  } catch { /* key unset */ }
  return "eager";
}

export async function isolate(cwd: string, label: string, stage: "birth" | "turn" = "birth"): Promise<Isolated | null> {
  if (!AUTO_ISOLATE) return null;
  const info = await repoInfo(cwd);
  if (!info || info.isWorktree) return null;

  const mode = await isolateMode(info.base);
  if (mode === "off") return null;
  // A lazy repo declines the birth-time tree — the placement pass calls back with stage "turn"
  // if this chat ever writes here under contention.
  if (mode === "lazy" && stage === "birth") return null;

  // Name allocation and creation are not atomic — `takenNames` reads the filesystem, `task new` writes
  // it — so two panes opened within the same second both pick `chat` and the second one loses. Retry
  // rather than surface it: the caller creates the pane either way, and a THROW here means the pane is
  // silently created unisolated, which is the collision this whole feature exists to prevent. Bounded,
  // because a failure that isn't a name collision must not spin.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const name = nameFor(label, await takenNames(info.base));
    try {
      return await create(info, name);
    } catch (e) {
      lastErr = e;
      if (!/already exists/i.test(String((e as Error)?.message || e))) throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** One creation attempt, on whichever backend this repo has. */
async function create(info: { base: string; hasTaskCli: boolean }, name: string): Promise<Isolated> {
  if (info.hasTaskCli && isOwnRepo(info.base)) {
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

  if (fs.existsSync(cli) && isOwnRepo(base)) {
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
 * Drop a worktree that was never used.
 *
 * An auto-created tree is a guess about what a chat was going to do, and a guess that turns out wrong
 * should cost nothing — a pane opened, never written in, and closed leaves a checkout and a branch
 * behind forever otherwise.
 *
 * > 🐛 **This used to pass `--force`, which is the one flag that turns the occupancy guard off.**
 * > `cmdRm` gates its claim/live-cwd check on `&& !force` (bin/task.mjs), so the call disabled exactly
 * > the protection §9 was written to install, then substituted a dirty/commits check that *cannot* see
 * > occupancy: `.minami-claim.json` is gitignored, so a claimed tree is not dirty. And closing a pane
 * > does not stop its session — that is deliberate and documented. So: open a blank second chat, send
 * > a message, close the tab while the agent is still reading, and the checkout was deleted underneath
 * > it. That is §9's recorded incident, reintroduced by code that imports `worktreeOf` from the module
 * > whose entire job is answering "is anyone working here?" and then never asked.
 *
 * Three things now stand between a running agent and `rm`, in order of how much they can see:
 *   1. the claim file, checked here, which is on disk and readable with the dashboard down;
 *   2. `task.mjs rm` WITHOUT `--force`, which re-checks the claim and the live cwd itself;
 *   3. clean-and-zero-commits-ahead, which is about the work, not the worker.
 * Any one of them refusing leaves the tree alone. `rm` failing is not an error here — the tree stays
 * and `task.mjs list` still shows it.
 */
export async function discardIfPristine(dir: string): Promise<boolean> {
  const wt = worktreeOf(dir);
  if (!wt || !fs.existsSync(dir)) return false;
  // Someone is in there. The pane that closed is not necessarily the only owner, and its own session
  // may still be mid-turn — `closeSession` releases the claim, a closed TAB does not.
  if (isFresh(readClaim(dir))) return false;
  const base = path.resolve(dir, "..", "..");
  try {
    const dirty = (await git(["status", "--porcelain"], dir)).trim();
    if (dirty) return false;
    const from = (await git(["config", "--get", "minami.base"], dir).catch(() => "")) || "main";
    const ahead = (await git(["rev-list", "--count", `${from}..HEAD`], dir)).trim();
    if (ahead !== "0") return false;
    const cli = path.join(base, "bin", "task.mjs");
    if (fs.existsSync(cli) && isOwnRepo(base)) {
      // No `--force`: let cmdRm's own occupancy check have the last word. It exits non-zero when the
      // tree is occupied, which lands in the catch below and leaves everything in place.
      await exec(process.execPath, [cli, "rm", wt.task], { cwd: base, maxBuffer: 8 << 20 });
    } else {
      await git(["worktree", "remove", dir], base);
      await git(["branch", "-d", `task/${wt.task}`], base).catch(() => "");
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * A chat whose worktree has been recycled can still be continued — in the repo the tree came from.
 *
 * The other half of the recycling story. Worktrees are deliberately temporary now (secondBrain's
 * `prune-worktrees.sh` merges finished branches and removes their trees on every sync), but a
 * transcript's home directory under `~/.claude/projects` is derived from its cwd — so removing a
 * tree stranded every conversation born in it: reopening one hit the send route's cwd check with
 * "folder does not exist: …/.minami-worktrees/chat-6". The CONTENT of those chats was already
 * merged into the base branch; only the resume mechanics were broken, because `--resume` finds a
 * session by id inside the project dir its cwd maps to.
 *
 * So: move the transcript (and its sidechain dir, if any) into the BASE folder's project dir and
 * answer with that folder for the session to resume in. The base is where the branch was merged,
 * so the chat continues against exactly the files its own work became part of. Rename, not copy —
 * two homes for one session id would let two panes spawn rival writers, the §9 corruption.
 *
 * Returns the base folder to resume in, or null when this isn't that situation (cwd not under
 * TREES_DIR, base gone too, no such transcript) — the caller then falls through to its normal
 * "does not exist" refusal.
 */
export function rehomeStrandedTranscript(cwd: string, sessionId: string): string | null {
  const m = new RegExp(`^(.*)/${TREES_DIR.replace(/\./g, "\\.")}/[^/]+/?$`).exec(cwd);
  if (!m) return null;
  const base = m[1];
  try { if (!fs.statSync(base).isDirectory()) return null; } catch { return null; }
  return moveTranscriptHome(sessionId, cwd, base) ? base : null;
}

/**
 * Move one conversation's on-disk home from one folder's project dir to another's. The primitive
 * under both rescue paths: a recycled tree's stranded chat (rehomeStrandedTranscript) and the
 * placement pass relocating a live chat to the repo its work is actually in (§3). `--resume` finds
 * a session by id inside the project dir its cwd maps to, so moving the file IS moving the chat.
 * Rename, not copy — one session id in two project dirs would let two panes spawn rival writers
 * into one JSONL, the §9 corruption.
 */
export function moveTranscriptHome(sessionId: string, fromCwd: string, toCwd: string): boolean {
  // The CLI's project-dir slug: every non-alphanumeric character becomes "-". Matches the observed
  // on-disk form ("/Users/x/secondBrain/.minami-worktrees/chat-2" → "-Users-x-secondBrain--minami-worktrees-chat-2").
  const slug = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");
  const projects = path.join(os.homedir(), ".claude", "projects");
  const src = path.join(projects, slug(fromCwd), sessionId + ".jsonl");
  const toDir = path.join(projects, slug(toCwd));
  const dst = path.join(toDir, sessionId + ".jsonl");
  try {
    if (fs.existsSync(dst)) return true; // already moved — a reload racing an earlier move
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(toDir, { recursive: true });
    fs.renameSync(src, dst);
    // Sidechain dir (subagent transcripts) rides along; losing it only loses subagent detail, so
    // a failure here must not undo the move that already happened.
    const side = path.join(projects, slug(fromCwd), sessionId);
    if (fs.existsSync(side) && !fs.existsSync(path.join(toDir, sessionId))) {
      try { fs.renameSync(side, path.join(toDir, sessionId)); } catch { /* detail, not the chat */ }
    }
    return true;
  } catch {
    return false;
  }
}
