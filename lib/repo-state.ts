// What branch a session's checkout is ACTUALLY on, and how far it has fallen behind the line that is
// really moving — measured by the server, with a fetch, and handed to the model as fact.
//
// Why this exists (2026-09-07, ~/secondBrain session e3607727):
//
//   A session spent five and a half hours migrating a design kit into an ecvision homepage, previewing
//   it, and reporting progress. Thomas said "feel weird that the home changed… I have just updated a
//   new homepage to ecvision and it's on github already, but you keep spitting out the outdated
//   version". The session had already told him, with a confident forensic write-up, that his last push
//   was three weeks old and his memory was wrong — and offered him a multiple-choice question with
//   "Nothing — the homepage is correct, I misremembered" as an option. He was right and it talked him
//   out of it. Twice.
//
//   Two facts it never checked, both one command away:
//     1. It read `origin/main` without ever running `git fetch`. A remote-tracking ref is a CACHE; it
//        only moves when you fetch. Every number in that write-up was three weeks stale.
//     2. It never asked which branch the checkout was on. `~/ecvision` sat on
//        `feature/ads-reads-and-capture-import`, 237 commits behind `origin/develop`, never merged.
//        `main` was a decoy that hadn't advanced since Aug 13; `develop` was the trunk and had moved
//        that morning. Five hours of work landed on the dead branch.
//
// The lesson is not "remind the model to run git fetch". A prompt that says "be careful" loses to a
// working tree that renders and a `git log` that looks busy — the session had every reason to believe
// what it saw. The fix is the same one this codebase already applied to permission modes and to
// auto-compact: the server measures, and the model is TOLD, rather than being trusted to ask.
//
// So: read-only, no side effects beyond an ordinary `git fetch`, and cheap enough to run at every
// session birth. Nothing here decides anything — it produces facts and a briefing paragraph.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Remote branches that are plausibly "the line everyone works on", most-likely first. */
const TRUNK_CANDIDATES = ["develop", "main", "master", "trunk"];

/** How old a fetch may be before the briefing calls the refs stale. */
export const FRESH_MS = Number(process.env.MINAMI_REPO_FRESH_MS || 10 * 60_000);

/** Cache TTL for a computed state. Long enough that a burst of sends doesn't re-shell git, short
 *  enough that a branch switch in a terminal shows up in the next chat. */
const CACHE_MS = 30_000;

/** Never fetch the same repo more often than this, however many sessions are born in it. */
const FETCH_COOLDOWN_MS = Number(process.env.MINAMI_REPO_FETCH_COOLDOWN_MS || 5 * 60_000);

/** Hard stop on a single `git fetch`. Generous, because this normally runs on the autopilot tick with
 *  nobody waiting; the caller that DOES have someone waiting uses its own, much shorter budget. */
const FETCH_TIMEOUT_MS = Number(process.env.MINAMI_REPO_FETCH_TIMEOUT_MS || 25_000);

/** How long `primeRepoState` will make a user wait before shipping what it already knows. The first
 *  HTTPS fetch of the day can take tens of seconds while a credential helper wakes up; a chat that
 *  hangs on send would be a far worse bug than the one this module fixes. */
const PRIME_BUDGET_MS = Number(process.env.MINAMI_REPO_PRIME_BUDGET_MS || 6_000);

export type TrunkCandidate = {
  /** e.g. "origin/develop" */
  ref: string;
  /** Unix seconds of its tip commit — how we tell a live trunk from a decoy. */
  at: number;
  /** How many commits HEAD is behind it. */
  behind: number;
};

export type RepoState = {
  root: string;
  /** Branch name, or null when HEAD is detached. */
  branch: string | null;
  head: string;
  /** Count of uncommitted files (staged + unstaged + untracked). */
  dirty: number;
  /** True when this checkout is a linked worktree rather than the main one. */
  worktree: boolean;
  /** The branch this checkout's own branch tracks, if any. */
  upstream: string | null;
  /** Where `origin/HEAD` points, when the remote has published a default. */
  remoteDefault: string | null;
  /** Every plausible trunk that exists on the remote, newest tip first. */
  candidates: TrunkCandidate[];
  /** The candidate whose tip is newest — the line that is actually moving. */
  moving: TrunkCandidate | null;
  /** Is HEAD an ancestor of the moving line? False means this work is not on the trunk's history. */
  merged: boolean;
  /** Commits on HEAD that the moving line doesn't have. */
  ahead: number;
  /** When origin was last fetched (mtime of FETCH_HEAD), or null if never. */
  fetchedAt: number | null;
  /** True when the remote-tracking refs are older than FRESH_MS — i.e. not safe to compare against. */
  stale: boolean;
};

const cache = new Map<string, { at: number; state: RepoState | null }>();
const lastFetch = new Map<string, number>();
const fetching = new Set<string>();

async function git(args: string[], cwd: string, timeout = 10_000): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/** Same call, but a non-zero exit is an answer rather than a throw — most of these questions are
 *  "does this ref exist", where failure IS the information. */
async function gitOk(args: string[], cwd: string): Promise<string | null> {
  try { return await git(args, cwd); } catch { return null; }
}

export async function repoRoot(cwd: string): Promise<string | null> {
  return await gitOk(["rev-parse", "--show-toplevel"], cwd);
}

/** mtime of FETCH_HEAD in the repo's COMMON git dir — a linked worktree shares the remote refs of the
 *  checkout it was created from, so asking its own `.git` file would report "never fetched" forever. */
async function fetchedAtOf(cwd: string): Promise<number | null> {
  const common = await gitOk(["rev-parse", "--git-common-dir"], cwd);
  if (!common) return null;
  // Older git returns this relative to the cwd it was asked in, newer git may return it absolute.
  try { return fs.statSync(path.resolve(cwd, common, "FETCH_HEAD")).mtimeMs; } catch { return null; }
}

/**
 * Find the repo root without shelling out, so a SYNCHRONOUS caller can reach the cache.
 *
 * The manager builds a session's `query()` in one synchronous breath — there is no await to hang an
 * async measurement on — but the routes that call into it are async. So the async half primes the
 * cache and this half reads it. A miss is a briefing that arrives one turn later, never a stall.
 */
export function repoRootSync(cwd: string): string | null {
  // Resolved, because the cache is keyed on `git rev-parse --show-toplevel`, which is ALWAYS resolved.
  // On macOS /tmp is a symlink to /private/tmp, so an unresolved key here would never match what the
  // async side stored — a cache miss that looks exactly like "this feature does nothing".
  let dir: string;
  try { dir = fs.realpathSync(cwd); } catch { return null; }
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir; // a dir in a checkout, a file in a worktree
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/**
 * Measure a checkout. Read-only — this never fetches; see `refreshRepo` for that, and read `stale` to
 * know whether the numbers below are worth anything.
 */
export async function repoState(cwd: string, opts?: { fresh?: boolean }): Promise<RepoState | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;

  const hit = cache.get(root);
  if (!opts?.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.state;

  const state = await measure(root).catch(() => null);
  cache.set(root, { at: Date.now(), state });
  return state;
}

async function measure(root: string): Promise<RepoState | null> {
  const head = await gitOk(["rev-parse", "HEAD"], root);
  if (!head) return null; // a repo with no commits yet — nothing to be behind

  const branchRaw = await gitOk(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
  const status = (await gitOk(["status", "--porcelain"], root)) || "";
  const dirty = status ? status.split("\n").filter(Boolean).length : 0;
  const worktree = (await gitOk(["rev-parse", "--is-inside-work-tree"], root)) === "true"
    && (await gitOk(["rev-parse", "--git-dir"], root)) !== ".git";
  const upstream = await gitOk(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], root);
  const remoteDefault = (await gitOk(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root)) || null;

  // Every plausible trunk that actually exists, with its tip date. Asking for the DATE is the whole
  // point: `main` existing tells you nothing, and in the incident that motivated this file `main` was
  // three weeks stale while `develop` had moved that morning. A checkout can look perfectly current
  // against the wrong ref.
  const wanted = new Set([...TRUNK_CANDIDATES.map((b) => `origin/${b}`), ...(remoteDefault ? [remoteDefault] : [])]);
  const listed = (await gitOk(
    ["for-each-ref", "--format=%(refname:short) %(committerdate:unix)", "refs/remotes/origin"],
    root,
  )) || "";

  const candidates: TrunkCandidate[] = [];
  for (const line of listed.split("\n")) {
    const [ref, ts] = line.trim().split(/\s+/);
    if (!ref || !wanted.has(ref)) continue;
    // `A...B` with --left-right counts each side's exclusive commits: left = behind, right = ahead.
    const counts = await gitOk(["rev-list", "--left-right", "--count", `${ref}...HEAD`], root);
    const [behind] = (counts || "0\t0").split(/\s+/).map(Number);
    candidates.push({ ref, at: Number(ts) || 0, behind: behind || 0 });
  }
  candidates.sort((a, b) => b.at - a.at);

  const moving = candidates[0] || null;
  let ahead = 0;
  let merged = true;
  if (moving) {
    const counts = await gitOk(["rev-list", "--left-right", "--count", `${moving.ref}...HEAD`], root);
    ahead = Number((counts || "0\t0").split(/\s+/)[1]) || 0;
    merged = (await gitOk(["merge-base", "--is-ancestor", "HEAD", moving.ref], root)) !== null;
  }

  const fetchedAt = await fetchedAtOf(root);
  return {
    root, branch, head, dirty, worktree, upstream, remoteDefault,
    candidates, moving, merged, ahead, fetchedAt,
    stale: fetchedAt == null || Date.now() - fetchedAt > FRESH_MS,
  };
}

/**
 * Fetch a repo's remote refs, at most once per cooldown, never throwing and never blocking a caller
 * that doesn't await it. Returns true if a fetch actually ran.
 *
 * `--prune` because a deleted remote branch left in the cache is another way to be confidently wrong,
 * and `--no-tags` to keep it cheap. Nothing here touches the working tree or any local branch: this is
 * the one git operation that changes what you KNOW without changing what you HAVE.
 */
export async function refreshRepo(root: string, opts?: { force?: boolean }): Promise<boolean> {
  if (process.env.MINAMI_REPO_FETCH === "0") return false;
  if (fetching.has(root)) return false;
  const last = lastFetch.get(root) || 0;
  if (!opts?.force && Date.now() - last < FETCH_COOLDOWN_MS) return false;

  fetching.add(root);
  try {
    await git(["fetch", "--quiet", "--prune", "--no-tags", "origin"], root, FETCH_TIMEOUT_MS);
    lastFetch.set(root, Date.now());
    cache.delete(root); // the numbers just changed — never serve the pre-fetch answer
    return true;
  } catch {
    // No remote, no network, no credentials — all ordinary. The briefing reports `stale` and the model
    // is told not to trust the comparison, which is the correct outcome either way.
    lastFetch.set(root, Date.now()); // cool down on failure too, or every send retries a dead remote
    // A failed fetch does NOT mean nothing was fetched. git writes FETCH_HEAD and updates
    // remote-tracking refs as it goes, so a run that is killed by the timeout, or that exits non-zero
    // on one ref out of many, can still have moved the refs — observed here on the first HTTPS fetch
    // of the day, which blew the timeout while leaving a perfectly updated FETCH_HEAD behind. Drop the
    // cache on both paths, or that partial success is invisible until the TTL expires.
    cache.delete(root);
    return false;
  } finally {
    fetching.delete(root);
  }
}

/**
 * Is this state worth interrupting someone about?
 *
 * Note the asymmetry with `repoBriefing`, which is deliberate: the model is told everything, and the
 * human is told only what they can act on. A task worktree under `.minami-worktrees/` is SUPPOSED to
 * sit on its own branch off the trunk — that is what isolating a chat means (§9) — so alerting on it
 * would fire on every vault chat and train the alert to be ignored, which is exactly what the overlap
 * banner did before it learned to read the isolation mode. The briefing still carries the numbers,
 * because a model reasoning about that branch genuinely needs them.
 */
export function repoConcern(st: RepoState | null): "off-trunk" | "behind" | "stale" | null {
  if (!st || !st.moving) return null; // no remote, or no trunk-shaped branch — nothing to be behind
  if (/[/\\]\.minami-worktrees[/\\]/.test(st.root)) return null;
  // Not on the trunk's history at all — the shape of the incident this file exists for.
  if (!st.merged && st.moving.behind > 0) return "off-trunk";
  if (st.moving.behind >= 25) return "behind";
  if (st.stale) return "stale";
  return null;
}

const rel = (root: string) => root.replace(/^\/Users\/[^/]+\//, "~/");

/** One line for a pane notice — the fact, not the advice. */
export function repoNotice(st: RepoState | null): string | null {
  const concern = repoConcern(st);
  if (!concern || !st || !st.moving) return null;
  const where = `${rel(st.root)} · ${st.branch || "detached HEAD"}`;
  if (concern === "off-trunk") {
    return `${where} is ${st.moving.behind} commits behind ${st.moving.ref} and not merged into it — work here is not on the line that's moving`;
  }
  if (concern === "behind") return `${where} is ${st.moving.behind} commits behind ${st.moving.ref}`;
  return `${where}: origin was last fetched ${ago(st.fetchedAt)} — remote-tracking refs are a cache, not the remote`;
}

function ago(at: number | null): string {
  if (!at) return "never";
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

/**
 * The stanza appended to a session's system prompt.
 *
 * Written as MEASUREMENTS with a timestamp, not as instructions to go and check — the failure being
 * prevented is a model that had no reason to doubt what it saw, so handing it the answer beats telling
 * it to be suspicious. The one rule at the end is there because these numbers go stale during a long
 * session, which is exactly how the original mistake was made.
 */
export function repoBriefing(st: RepoState | null): string | null {
  if (!st) return null;
  const lines: string[] = [];
  lines.push(`# This checkout, measured by the server at session start`);
  lines.push(`- Repo: ${st.root}${st.worktree ? " (a linked worktree, not the main checkout)" : ""}`);
  lines.push(`- On branch: ${st.branch || "DETACHED HEAD"}${st.upstream ? ` (tracks ${st.upstream})` : " (no upstream)"}`);
  if (st.dirty) lines.push(`- Uncommitted: ${st.dirty} file(s)`);
  lines.push(`- origin last fetched: ${ago(st.fetchedAt)}${st.stale ? " — STALE" : ""}`);

  if (st.moving) {
    lines.push(
      `- The remote branch that moved most recently is ${st.moving.ref} (tip ${ago(st.moving.at * 1000)}). ` +
      `This checkout is ${st.moving.behind} commit(s) behind it and ${st.ahead} ahead` +
      `${st.merged ? "" : ", and HEAD is NOT an ancestor of it"}.`,
    );
    const others = st.candidates.filter((c) => c.ref !== st.moving!.ref);
    if (others.length) {
      lines.push(`- Other trunk-shaped branches: ${others.map((c) => `${c.ref} (tip ${ago(c.at * 1000)}, ${c.behind} ahead of here)`).join(", ")}.`);
    }
    if (st.remoteDefault && st.remoteDefault !== st.moving.ref) {
      lines.push(`- Note: origin's declared default is ${st.remoteDefault}, but ${st.moving.ref} is the one that is actually moving. Do not assume the default branch is the trunk.`);
    }
  }

  lines.push(
    `\nThese figures are from a fetch at session start, and they go stale as you work. ` +
    `A remote-tracking ref (origin/anything) is a local CACHE — \`git log origin/main\` reports what was true at the last fetch, not what is on the remote. ` +
    `So before you make ANY claim about what is pushed, what the user's latest work is, how far behind something is, or which version of a file is current: run \`git fetch\` first, and check which branch HEAD is on. ` +
    `If the user says their work is already pushed and you cannot see it, they are far more likely to be right than your cached refs are — fetch and check the other branches before you tell them otherwise.`,
  );
  return lines.join("\n");
}

// ── the sync/async bridge ─────────────────────────────────────────────────────────────────────────
//
// `ensureSession()` builds a session's whole `query()` synchronously, so it cannot await a git call.
// The routes that reach it can. `primeRepoState` is called from the async side before the session is
// born; `cachedRepoState` is what the sync side reads. Degrading to "no briefing on the very first
// chat in a repo we've never seen" is the acceptable failure — a stall at session birth is not.

/**
 * Measure a repo, fetching first when the refs are stale, and leave the answer in the cache.
 *
 * The fetch is awaited rather than fired-and-forgotten, deliberately: a briefing built on unfetched
 * refs is the exact artefact that caused the incident this module exists for, and it would be worse
 * than no briefing — it would carry a timestamp and read as verified. A warm fetch is under a second,
 * and the per-repo cooldown means most sends skip it entirely.
 *
 * But only up to PRIME_BUDGET_MS. Past that the fetch is left running (it still updates the cache for
 * the next turn, and the autopilot tick finishes the job) and the caller gets the pre-fetch state —
 * which is honest rather than silent, because `stale` is true on it and the briefing then says so in
 * capitals and tells the model to fetch before claiming anything.
 */
export async function primeRepoState(cwd: string): Promise<RepoState | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const before = await repoState(root);
  if (!before?.stale) return before;

  const done = refreshRepo(root).then(() => repoState(root, { fresh: true }));
  const timeout = new Promise<"budget">((r) => setTimeout(() => r("budget"), PRIME_BUDGET_MS).unref?.());
  const winner = await Promise.race([done.catch(() => null), timeout]);
  return winner === "budget" ? before : winner;
}

/** The cached measurement for whatever repo `cwd` is in, or null if we haven't looked yet. Never
 *  shells out; safe from a synchronous path. */
export function cachedRepoState(cwd: string): RepoState | null {
  const root = repoRootSync(cwd);
  if (!root) return null;
  return cache.get(root)?.state ?? null;
}
