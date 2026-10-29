#!/usr/bin/env node
// One task = one git worktree = one branch = one agent. Isolation instead of etiquette.
//
// WHY
// Every live chat pane spawns a `claude` whose cwd is the project folder. Two panes on one project
// therefore share a working tree, a branch and an index — so agent A's `grep` can return code agent B
// is halfway through rewriting, and whoever writes last wins, silently. Nothing in git or the SDK
// prevents this; the transcripts show 5 overlapping pairs in a single day. A worktree is git's own
// answer: a second checkout of the same repository, sharing the object store (cheap), with its own
// branch, index and files. Collisions stop being unlikely and start being impossible.
//
// The merge is where conflicts are supposed to surface — git can reason about them there. Overwrites
// in a shared checkout are not conflicts; they are just losses, with nothing to resolve.
//
//   node bin/task.mjs new <name> [--base <b>] [--json]  worktree + branch, ready for an agent
//   node bin/task.mjs list [--json]                  every task, its branch, dirt, and preview port
//   node bin/task.mjs build <name>                   build INSIDE the worktree, own dist dir
//   node bin/task.mjs preview <name>                 build, then serve it on its own port
//   node bin/task.mjs merge <name> [--keep] [--json] verify → build → merge into base (serialised)
//   node bin/task.mjs rm <name> [--force]            drop the worktree (and its branch)
//   node bin/task.mjs tidy [--dry] [--json]          remove merged, idle worktrees and merged branches
//
// Ports are derived from the task name, never assigned round-robin: a preview must land on the same
// port every time or you cannot bookmark it, and two tasks must not silently collide on one.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { emit } from "./minami-event.mjs";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const TREES = path.join(ROOT, ".minami-worktrees");
const LOCK = "/tmp/minami-merge.lock";
const PORT_BASE = 3010;
const PORT_SPAN = 90; // 3010–3099, well clear of :3000 (live) and :3001 (dev:iterate)

const git = (args, opts = {}) =>
  execFileSync("git", args, { encoding: "utf8", cwd: opts.cwd || ROOT, stdio: opts.stdio || "pipe" });
const tryGit = (args, opts = {}) => { try { return { ok: true, out: git(args, opts) }; } catch (e) { return { ok: false, out: String(e.stderr || e.stdout || e.message) }; } };

// Stable per-name port: same task, same port, forever. FNV-1a — short, no deps, good spread.
function fnvSlot(name) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % PORT_SPAN;
}

// A good hash is not a free port. The span is small, so the birthday bound bites long before the
// span is full — `bell-anchor` and `resume-audit2` both landed on :3024 with only three tasks alive.
// Two tasks on one port is the one failure a *stable* port scheme must not have, and it is silent:
// the second `preview` either fails to bind or, if the first has since stopped, quietly serves a
// different task's build to a URL you bookmarked. So the hash only picks a *preferred* slot and
// clashes probe forward from it.
//
// The probe walks names in sorted order, so a port depends solely on the SET of live task names —
// never on creation order or on which command happens to be asking. Consequence worth knowing: of
// two names that clash, the alphabetically earlier one keeps the natural slot and the later one
// moves, so removing a task can shift a port — but only for a name that was displaced to begin with.
function portsFor(names) {
  const taken = new Set();
  const out = new Map();
  for (const n of [...new Set(names)].sort()) {
    let s = fnvSlot(n);
    for (let i = 0; i < PORT_SPAN && taken.has(s); i++) s = (s + 1) % PORT_SPAN;
    if (taken.has(s)) throw new Error(`no free preview port: ${PORT_SPAN} slots, all taken`);
    taken.add(s);
    out.set(n, PORT_BASE + s);
  }
  return out;
}

// `list`, `new` and `preview` must agree, so all three derive from the same set: the tasks on disk
// plus `name` itself — `new` prints the port before the worktree is fully registered.
function portFor(name) {
  return portsFor([...taskNames(), name]).get(name);
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const dirFor = (name) => path.join(TREES, name);
const branchFor = (name) => `task/${name}`;

function currentBranch(cwd = ROOT) {
  return tryGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd }).out.trim() || "HEAD";
}
function isDirty(cwd) {
  return tryGit(["status", "--porcelain"], { cwd }).out.trim().length > 0;
}
/** A merge that stopped halfway leaves MERGE_HEAD behind. Everything else in this file assumes the
 *  base is in a normal state, and the autopilot must be able to SEE that it isn't. */
function isMerging(cwd) {
  const dir = tryGit(["rev-parse", "--git-dir"], { cwd }).out.trim();
  if (!dir) return false;
  return fs.existsSync(path.resolve(cwd, dir, "MERGE_HEAD"));
}

/** Committer time of HEAD, ms. The autopilot waits for this to settle: "committed" is not the same as
 *  "finished", and a run of commits 20 seconds apart is one thought, not three. */
function lastCommitTs(cwd) {
  const t = tryGit(["log", "-1", "--format=%ct"], { cwd }).out.trim();
  return t ? Number(t) * 1000 : 0;
}

// A worktree dir without .git is debris (an interrupted `new`, or a hand-deleted checkout), not a
// task — it must not claim a port or show up in the list.
function taskNames() {
  if (!fs.existsSync(TREES)) return [];
  return fs.readdirSync(TREES).filter((d) => fs.existsSync(path.join(TREES, d, ".git")));
}

function listTasks() {
  return taskNames()
    .map((d) => {
      const cwd = dirFor(d);
      const branch = currentBranch(cwd);
      const base = tryGit(["config", "--get", "minami.base"], { cwd }).out.trim() || "(unknown)";
      const ahead = tryGit(["rev-list", "--count", `${base}..HEAD`], { cwd }).out.trim() || "?";
      return { name: d, cwd, branch, base, ahead, dirty: isDirty(cwd), port: portFor(d) };
    });
}

// ── Occupancy ────────────────────────────────────────────────────────────────────────────────────
// "Is anyone working in this worktree?" — the question every destructive command here depends on.
//
// It used to be answered ONLY by `liveCwds().has(t.cwd)`: the set of session cwds, tested against a
// worktree path. That could never be true. `bin/task.mjs new` creates a worktree but nothing moves a
// session into it, so every session's cwd is the base checkout — `~/.claude/projects/` holds no
// worktree-rooted directory at all. The `agent-live` refusal below and the autopilot's `live === false`
// gate were therefore both unreachable, and autopilot merged and deleted trees agents were writing in.
//
// Now there are two signals and either is enough. The claim file is the one that works with the
// dashboard down, which this tool must support.
//
// The claim FORMAT is the contract shared with lib/worktree-claim.ts — this file is plain ESM and
// cannot import that TypeScript module without a build step, so it reads the same JSON by hand. Keep
// the field names and the TTL rule in step with it; there is a `_CONTRACT` export there naming both.
const CLAIM_FILE = ".minami-claim.json";
const CLAIM_TTL_MS = Math.max(60_000, Number(process.env.MINAMI_CLAIM_TTL_MS) || 10 * 60 * 1000);

function readClaim(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, CLAIM_FILE), "utf8"));
    if (!c || typeof c.heartbeatAt !== "number") return null;
    return c;
  } catch { return null; }
}
/** Fresh = heartbeat within the TTL. Measured from heartbeatAt, never claimedAt: a pane can sit warm
 *  for hours between turns and is still very much the owner. */
const claimFresh = (dir, now = Date.now()) => {
  const c = readClaim(dir);
  return !!c && now - c.heartbeatAt < CLAIM_TTL_MS;
};

// Which worktrees currently have a live agent, per the running dashboard. Best-effort: if :3000 is
// down the answer is simply "unknown", which must not be fatal — this tool has to work with the app
// off, that being one of its points.
async function liveCwds() {
  try {
    // Same env var every other caller uses (bin/agent.mjs, lib/agents/store.ts). This was the one
    // place that hardcoded the port, so a dashboard moved off :3000 reported "no live agents" —
    // an answer indistinguishable from the real thing, on a check whose whole job is to stop you
    // deleting a worktree someone is working in.
    const base = process.env.MINAMI_DASHBOARD_URL || "http://127.0.0.1:3000";
    const r = await fetch(`${base}/api/agent/live`, { signal: AbortSignal.timeout(1500) });
    const d = await r.json();
    return new Set(Object.values(d.activity || {}).map((x) => x.cwd));
  } catch { return null; }
}

function acquireLock(what) {
  try { fs.mkdirSync(LOCK); fs.writeFileSync(path.join(LOCK, "pid"), String(process.pid)); return true; }
  catch {
    const holder = (() => { try { return fs.readFileSync(path.join(LOCK, "pid"), "utf8").trim(); } catch { return ""; } })();
    // A crashed merge must not block every future one.
    // No pid (a plain file left at LOCK, or a dir from a merge killed before it wrote one) is a dead holder:
    // Number("") is 0, and kill(0, 0) signals our own process group — it always "succeeded", so a stray empty
    // /tmp/minami-merge.lock blocked every merge on the box (2026-10-29).
    let alive = false;
    if (/^\d+$/.test(holder) && Number(holder) > 0) { try { process.kill(Number(holder), 0); alive = true; } catch { alive = false; } }
    if (!alive) { fs.rmSync(LOCK, { recursive: true, force: true }); return acquireLock(what); }
    console.error(`✋ another ${what} is running (pid ${holder}). Merges are serialised on purpose.`);
    return false;
  }
}
const releaseLock = () => { try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* ignore */ } };

// `sink` turns this into a tee: output still streams to the terminal live (a build you can't watch is
// a build you'll assume hung), but the last few KB are also kept so a failure can be *quoted* in the
// alert rather than pointing at a log the reader would have to go open.
function run(cmd, args, cwd, env = {}, sink = null) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd, stdio: sink ? ["inherit", "pipe", "pipe"] : "inherit", env: { ...process.env, ...env } });
    if (sink) {
      const grab = (chunk, out) => { out.write(chunk); sink.push(chunk.toString()); };
      p.stdout.on("data", (c) => grab(c, process.stdout));
      p.stderr.on("data", (c) => grab(c, process.stderr));
    }
    p.on("exit", (code) => res(code === 0));
  });
}

/** The last `n` non-blank lines — what a build failure actually tells you is at the bottom. */
const tailOf = (sink, n = 12) =>
  sink.join("").split("\n").map((l) => l.replace(/\[[0-9;]*m/g, "").trimEnd())
    .filter((l) => l.trim()).slice(-n).join("\n");

// --- commands ---------------------------------------------------------------------------------------
/** Symlink the base's node_modules into a worktree. Worktrees share git objects, never node_modules,
 *  and a full install per task costs minutes and gigabytes while being byte-identical by construction
 *  (the task was branched from that package.json). If a task CHANGES dependencies, delete the link and
 *  install for real — the one case where sharing is wrong. Returns whether it linked anything. */
function linkModules(dir, { quiet = false } = {}) {
  if (fs.existsSync(path.join(dir, "node_modules"))) return false;
  const src = path.join(ROOT, "node_modules");
  if (!fs.existsSync(src)) return false;
  fs.symlinkSync(src, path.join(dir, "node_modules"), "dir");
  if (!quiet) console.log("   linked node_modules from the base checkout");
  return true;
}

async function cmdNew(raw, base, { json = false } = {}) {
  const name = slug(raw || "");
  const fail = (msg, code = 2) => {
    if (json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    process.exit(code);
  };
  if (!name) return fail("usage: task new <name>");
  const dir = dirFor(name), branch = branchFor(name);
  if (fs.existsSync(dir)) return fail(`task "${name}" already exists at ${dir}`);
  const from = base || currentBranch();
  fs.mkdirSync(TREES, { recursive: true });

  const exists = tryGit(["rev-parse", "--verify", branch]).ok;
  const r = exists
    ? tryGit(["worktree", "add", dir, branch])
    : tryGit(["worktree", "add", "-b", branch, dir, from]);
  if (!r.ok) return fail(r.out, 1);

  // Remember the base in the worktree's own config, so `merge` never has to guess where to land.
  tryGit(["config", "minami.base", from], { cwd: dir });
  // Link at CREATION, not lazily at first build. A worktree without node_modules has no `npm` at all —
  // `npm run build:check`, `npx next`, every script fails — and the agent that lands in one is usually
  // a chat pane that was put there automatically and never asked for a worktree in the first place. It
  // should find a checkout it can work in, not one it has to repair. `build` still links, for trees
  // created before this and for anyone who deleted the link to install for real.
  linkModules(dir, { quiet: json });

  if (json) {
    // The dashboard reads THIS to isolate a pane, so creation speaks the same JSON as `list`/`merge`
    // rather than being screen-scraped — the reason those two grew `--json` in the first place.
    console.log(JSON.stringify({ ok: true, name, dir, branch, base: from, port: portFor(name) }));
    return;
  }
  console.log(`✓ task ${name}`);
  console.log(`   dir    ${dir}`);
  console.log(`   branch ${branch}  (from ${from})`);
  console.log(`   port   ${portFor(name)}   node bin/task.mjs preview ${name}`);
  console.log(`\nPoint a chat pane at that folder — the agent then works in its own checkout, and`);
  console.log(`nothing it writes can collide with another agent in ${path.basename(ROOT)}.`);
}

async function cmdList({ json = false } = {}) {
  const tasks = listTasks();
  const live = await liveCwds();
  if (json) {
    // The autopilot reads THIS, not git directly — so the thing that decides "is this task ready"
    // stays one implementation. A second reader of git plumbing is a second set of gates to keep in
    // sync, and the one that drifts is always the automated one nobody watches.
    console.log(JSON.stringify({
      base: { root: ROOT, branch: currentBranch(), dirty: isDirty(ROOT), merging: isMerging(ROOT) },
      liveKnown: live !== null,
      tasks: tasks.map((t) => {
        const claimed = claimFresh(t.cwd);
        return {
          ...t,
          // Kept for anything still reading it, but it is no longer the gate — see `occupied`.
          live: live === null ? null : live.has(t.cwd),
          claimed,
          // The field the autopilot must gate on. `false` here means "asked both ways and nobody is
          // home", which is a real answer even with the dashboard unreachable, because a claim is
          // read off disk. That is the whole point: the old `live: null` made an unreachable
          // dashboard indistinguishable from an idle one.
          occupied: claimed || (live !== null && live.has(t.cwd)),
          lastCommitTs: lastCommitTs(t.cwd),
        };
      }),
    }));
    return;
  }
  if (!tasks.length) { console.log("no tasks. create one:  node bin/task.mjs new <name>"); return; }
  console.log(`${tasks.length} task(s)   base repo: ${ROOT} (${currentBranch()}${isDirty(ROOT) ? ", dirty" : ""})\n`);
  for (const t of tasks) {
    // Name WHY it's busy — a claim and a live cwd fail in different ways, so "occupied" alone would
    // send you looking in the wrong place when one of the two is wrong.
    const c = readClaim(t.cwd);
    const held = claimFresh(t.cwd) ? `  ● claimed by ${c?.owners?.length || 1} pane(s)` : "";
    const agent = live === null ? "" : live.has(t.cwd) ? "  ● agent live" : "";
    console.log(`${t.name.padEnd(22)} ${t.branch.padEnd(26)} +${String(t.ahead).padStart(3)} commits  :${t.port}${t.dirty ? "  ✎ uncommitted" : ""}${held}${agent}`);
  }
  if (live === null) console.log("\n(dashboard unreachable — live-cwd column omitted; claims still read from disk)");
}

async function cmdBuild(name, { quiet = false } = {}) {
  const dir = dirFor(name);
  if (!fs.existsSync(dir)) { console.error(`no task "${name}"`); process.exit(2); }
  linkModules(dir, { quiet });
  if (!quiet) console.log(`▸ building ${name} → .next-task (isolated dist dir, never touches .next)`);
  const sink = [];
  const started = Date.now();
  const ok = await run("npx", ["next", "build"], dir, { NEXT_DIST_DIR: ".next-task" }, sink);

  // A worktree build is usually started by an agent in a pane and then left alone for two minutes.
  // Whoever asked has moved on by the time it lands, so the result goes to the bell.
  const secs = Math.round((Date.now() - started) / 1000);
  const branch = currentBranch(dir);
  if (ok) {
    emit({ kind: "build", level: "success", title: `Build ✓ — ${name}`,
           body: `${branch} built clean in ${secs}s.\nMerge when ready:  node bin/task.mjs merge ${name}` });
  } else {
    emit({ kind: "build", level: "error", title: `Build failed — ${name}`,
           body: `${branch} · next build exited non-zero after ${secs}s\n\n${tailOf(sink)}` });
  }
  return ok;
}

async function cmdPreview(name) {
  const dir = dirFor(name);
  if (!fs.existsSync(dir)) { console.error(`no task "${name}"`); process.exit(2); }
  if (!(await cmdBuild(name))) { console.error("✗ build failed — not serving"); process.exit(1); }
  const port = portFor(name);
  console.log(`\n▸ ${name} → http://localhost:${port}   (ctrl-c to stop; :3000 is untouched)`);
  await run("npx", ["next", "start", "-p", String(port)], dir, { NEXT_DIST_DIR: ".next-task" });
}

async function cmdMerge(name, keep, { json = false } = {}) {
  // Every refusal below is also a JSON outcome, so a caller that cannot read stderr still learns
  // exactly which gate stopped it — the autopilot decides "skip quietly" vs "tell a human" from this.
  const say = (o) => { if (json) console.log(JSON.stringify(o)); };
  const dir = dirFor(name);
  if (!fs.existsSync(dir)) { console.error(`no task "${name}"`); process.exit(2); }
  const branch = currentBranch(dir);
  const base = tryGit(["config", "--get", "minami.base"], { cwd: dir }).out.trim();
  if (!base) { console.error("this task has no recorded base branch — merge it by hand"); process.exit(2); }

  if (isDirty(dir)) {
    say({ ok: false, reason: "task-dirty", task: name });
    console.error(`✗ ${name} has uncommitted changes. Commit them in the worktree first:`);
    console.error(`    git -C ${dir} add -A && git -C ${dir} commit -m "..."`);
    process.exit(2);
  }
  // Merging into a dirty base is how you lose work that was never committed anywhere. The base repo
  // right now usually IS dirty (that is the habit this whole tool is meant to replace), so this refusal
  // will fire often at first — deliberately.
  if (isDirty(ROOT)) {
    say({ ok: false, reason: "base-dirty", task: name });
    console.error(`✗ the base checkout (${ROOT}) has uncommitted changes on ${currentBranch()}.`);
    console.error("   Merging into it risks losing them. Commit or stash there first.");
    process.exit(2);
  }
  const live = await liveCwds();
  // Either signal is enough to refuse. Previously only the live-cwd half was consulted, and it could
  // never fire (see the Occupancy block above), so this refusal had never once run in production.
  const claimed = claimFresh(dir);
  if (claimed || (live && live.has(dir))) {
    say({ ok: false, reason: claimed ? "claimed" : "agent-live", task: name, owners: readClaim(dir)?.owners || [] });
    console.error(`✗ ${name} is occupied right now — let it finish before merging.`);
    console.error(claimed
      ? `   A pane claimed it ${Math.round((Date.now() - (readClaim(dir)?.heartbeatAt || 0)) / 1000)}s ago (${CLAIM_FILE}).`
      : `   A live session has it as its cwd.`);
    process.exit(2);
  }

  if (!acquireLock("merge")) { say({ ok: false, reason: "locked", task: name }); process.exit(3); }
  process.on("exit", releaseLock);
  try {
    console.log(`▸ building ${name} before merging — a task that cannot build does not get in`);
    if (!(await cmdBuild(name, { quiet: true }))) { say({ ok: false, reason: "build-failed", task: name }); console.error("✗ build failed — refusing to merge"); process.exit(1); }

    console.log(`▸ merging ${branch} → ${base}`);
    const m = tryGit(["merge", "--no-ff", branch, "-m", `merge task ${name}`], { cwd: ROOT });
    if (!m.ok) {
      const conflicts = tryGit(["diff", "--name-only", "--diff-filter=U"], { cwd: ROOT }).out.trim() || m.out;
      console.error("✗ merge conflict — this is the good failure mode: git can see it, and you can resolve it.");
      console.error(conflicts);
      console.error(`\n   resolve in ${ROOT}, then:  git commit`);
      console.error(`   or abandon:                git merge --abort`);
      // A conflicted merge leaves the base checkout mid-merge. Nothing else on the box will mention
      // that, and the next agent to touch the base will walk straight into it.
      say({ ok: false, reason: "conflict", task: name, branch, base, files: conflicts.split("\n").filter(Boolean) });
      emit({ kind: "merge", level: "error", title: `Merge conflict — ${name}`,
             body: `${branch} → ${base}. The base checkout is mid-merge; resolve or abort it before anything else runs there.\n\n${conflicts}` });
      process.exit(1);
    }
    say({ ok: true, task: name, branch, base });
    console.log(`✓ merged into ${base}`);
    emit({ kind: "merge", level: "success", title: `Merged ${name} → ${base}`,
           body: `Built clean and merged. Nothing is live yet — deploy when you're ready:\n  bash bin/deploy.sh --detach` });
    if (!keep) {
      tryGit(["worktree", "remove", dir, "--force"]);
      tryGit(["branch", "-d", branch]);
      console.log(`✓ removed worktree and branch (keep them with --keep)`);
    }
    console.log(`\nNothing is live yet — deploy when you're ready:  bash bin/deploy.sh --detach`);
  } finally { releaseLock(); }
}

async function cmdRm(name, force) {
  const dir = dirFor(name);
  if (!fs.existsSync(dir)) { console.error(`no task "${name}"`); process.exit(2); }
  if (isDirty(dir) && !force) {
    console.error(`✗ ${name} has uncommitted changes — use --force to discard them`);
    process.exit(2);
  }
  // `rm` had NO occupancy check at all — only the dirty one. So the most destructive command here
  // would happily delete a worktree an agent was working in, provided that agent had committed. That
  // is not a hypothetical: it is what a merge does immediately before removing the tree, so "clean"
  // is the NORMAL state of an occupied worktree at exactly the moment something wants to delete it.
  const claimed = claimFresh(dir);
  const live = await liveCwds();
  if ((claimed || (live && live.has(dir))) && !force) {
    const owners = readClaim(dir)?.owners || [];
    console.error(`✗ ${name} is occupied — ${claimed ? `claimed by ${owners.length || 1} pane(s)` : "a live session has it as its cwd"}.`);
    console.error(`   Removing it would delete the checkout out from under a running agent.`);
    console.error(`   Wait for it to finish, or --force if you are certain.`);
    process.exit(2);
  }
  const branch = currentBranch(dir);
  const r = tryGit(["worktree", "remove", dir, ...(force ? ["--force"] : [])]);
  if (!r.ok) { console.error(r.out); process.exit(1); }
  const d = tryGit(["branch", force ? "-D" : "-d", branch]);
  console.log(`✓ removed ${name}` + (d.ok ? ` and ${branch}` : ` (branch ${branch} kept: ${d.out.trim().split("\n")[0]})`));
}

// ── Tidy ─────────────────────────────────────────────────────────────────────────────────────────────
// Removes what is provably finished: a worktree whose every commit is already in the base, and a branch
// that is fully merged with no worktree on it. Nothing it deletes holds a commit the base lacks, so it
// cannot lose work. Unmerged branches, dirty trees and stashes are reported, never touched.
//
// WHY THIS EXISTS (2026-10-28): `merge` removes its tree and branch, but most merges don't go through it.
// A chat merges its own branch by hand (`git merge` in the base) and has to keep the folder it is
// running in, and nothing came back for it after the chat ended. The janitor only recycles trees idle
// 3+ days, only when the disk is low, and never deletes branches. That left 8 trees and 19 branches,
// all merged. The autopilot runs this every few minutes (lib/autopilot/runner.ts) so nobody has to ask.
//
// "In use" is any one of: a fresh claim, a live session cwd (dashboard), a process whose cwd is inside
// (lsof — this covers Claude Code's own `.claude/worktrees/` sessions, which never claim), a
// mid-operation, a `git worktree lock`, or activity in the last QUIET_MS. The quiet window protects a
// tree `new` just made: it is clean and has nothing ahead of the base, so it looks exactly like a
// finished one until its session starts.
const QUIET_MS = 30 * 60_000;
const TIDY_CLAIM_TTL_MS = 30 * 60_000; // the janitor's figure; longer than CLAIM_TTL_MS on purpose

function processCwds() {
  try {
    const out = execFileSync("lsof", ["-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter((l) => l.startsWith("n/")).map((l) => l.slice(1));
  } catch (e) {
    // lsof exits 1 when some processes can't be read, with a perfectly good list on stdout
    const out = String(e.stdout || "");
    if (!out) return null;
    return out.split("\n").filter((l) => l.startsWith("n/")).map((l) => l.slice(1));
  }
}

function worktreeEntries() {
  return tryGit(["worktree", "list", "--porcelain"]).out.split("\n\n").map((b) => ({
    path: b.match(/^worktree (.+)$/m)?.[1],
    branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] || null,
    locked: /^locked/m.test(b),
  })).filter((w) => w.path && w.path !== ROOT);
}

async function cmdTidy({ json = false, dry = false } = {}) {
  const out = { removed: [], branches: [], kept: [], stashes: 0, dry };
  const base = currentBranch(ROOT);
  if (isMerging(ROOT) || base === "HEAD") {
    out.skipped = isMerging(ROOT) ? "base mid-merge" : "base detached";
    if (json) console.log(JSON.stringify(out)); else console.log(`tidy skipped: ${out.skipped}`);
    return;
  }
  const live = await liveCwds();
  const procs = processCwds();
  // Unknown occupancy is not "free": without lsof we cannot see Claude Code's own sessions at all.
  if (procs === null) {
    out.skipped = "lsof unavailable";
    if (json) console.log(JSON.stringify(out)); else console.log("tidy skipped: lsof unavailable");
    return;
  }
  const inside = (dir) => procs.some((c) => c === dir || c.startsWith(dir + "/"));
  const merged = (ref) => tryGit(["merge-base", "--is-ancestor", ref, base]).ok;
  const now = Date.now();

  for (const w of worktreeEntries()) {
    const ours = w.path.startsWith(TREES + "/") || w.path.startsWith(path.join(ROOT, ".claude", "worktrees") + "/");
    if (!ours) continue; // somebody else's layout — not ours to judge
    const name = path.relative(ROOT, w.path);
    const keep = (why) => out.kept.push({ tree: name, why });
    if (!fs.existsSync(w.path)) continue; // `worktree prune` below handles a vanished folder
    if (w.locked) { keep("locked"); continue; }
    if (!w.branch) { keep("detached HEAD"); continue; }
    if (isMerging(w.path)) { keep("mid-merge"); continue; }
    if (isDirty(w.path)) { keep("uncommitted changes"); continue; }
    if (!merged(w.branch)) { keep(`${tryGit(["rev-list", "--count", `${base}..${w.branch}`]).out.trim()} commit(s) not in ${base}`); continue; }
    const c = readClaim(w.path);
    if (c && now - c.heartbeatAt < TIDY_CLAIM_TTL_MS) { keep("claimed by a pane"); continue; }
    if (live && live.has(w.path)) { keep("live session"); continue; }
    if (inside(w.path)) { keep("a process is running in it"); continue; }
    let last = Math.max(lastCommitTs(w.path), c?.heartbeatAt || 0);
    try { last = Math.max(last, fs.statSync(path.join(w.path, ".git")).mtimeMs); } catch { /* ignore */ }
    if (now - last < QUIET_MS) { keep("active in the last 30 min"); continue; }

    if (!dry) {
      // no --force: the tree is clean, so a refusal means something changed under us — keep it
      const r = tryGit(["worktree", "remove", w.path]);
      if (!r.ok) { keep(`remove refused: ${r.out.trim().split("\n").pop()}`); continue; }
    }
    out.removed.push({ tree: name, branch: w.branch });
  }
  if (!dry) tryGit(["worktree", "prune"]);

  // Branches: fully merged, checked out nowhere, not tracking a remote (a pushed branch is someone's).
  const checkedOut = new Set([base, ...worktreeEntries().map((w) => w.branch).filter(Boolean)]);
  const refs = tryGit(["for-each-ref", "--format=%(refname:short)\t%(upstream)", "refs/heads/"]).out.trim().split("\n").filter(Boolean);
  for (const line of refs) {
    const [b, upstream] = line.split("\t");
    if (checkedOut.has(b) || upstream || ["main", "master"].includes(b)) continue;
    if (!merged(b)) { out.kept.push({ branch: b, why: `not merged into ${base}` }); continue; }
    if (!dry) {
      const r = tryGit(["branch", "-d", b]);
      if (!r.ok) { out.kept.push({ branch: b, why: r.out.trim().split("\n").pop() }); continue; }
    }
    out.branches.push(b);
  }
  out.stashes = tryGit(["stash", "list"]).out.trim().split("\n").filter(Boolean).length;

  if (json) { console.log(JSON.stringify(out)); return; }
  const verb = dry ? "would remove" : "removed";
  console.log(`${verb} ${out.removed.length} worktree(s), ${out.branches.length} branch(es)`);
  for (const r of out.removed) console.log(`  − ${r.tree} (${r.branch})`);
  for (const b of out.branches) console.log(`  − branch ${b}`);
  for (const k of out.kept) console.log(`  · kept ${k.tree || "branch " + k.branch}: ${k.why}`);
  if (out.stashes) console.log(`  · ${out.stashes} stash entr${out.stashes === 1 ? "y" : "ies"} — not touched (git stash list)`);
}

// --- main -------------------------------------------------------------------------------------------
const [cmd, arg] = process.argv.slice(2);
const has = (f) => process.argv.includes(f);
const val = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };

const help = () => console.log(
  fs.readFileSync(new URL(import.meta.url), "utf8").split("\n")
    .filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));

switch (cmd) {
  case "new": await cmdNew(arg, val("--base"), { json: has("--json") }); break;
  case "list": case "ls": await cmdList({ json: has("--json") }); break;
  case "build": await cmdBuild(arg); break;
  case "preview": await cmdPreview(arg); break;
  case "merge": await cmdMerge(arg, has("--keep"), { json: has("--json") }); break;
  case "rm": case "remove": await cmdRm(arg, has("--force")); break;
  case "tidy": await cmdTidy({ json: has("--json"), dry: has("--dry") }); break;
  default: help();
}
