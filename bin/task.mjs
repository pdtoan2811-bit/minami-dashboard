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
//   node bin/task.mjs new <name> [--base <branch>]   worktree + branch, ready for an agent
//   node bin/task.mjs list [--json]                  every task, its branch, dirt, and preview port
//   node bin/task.mjs build <name>                   build INSIDE the worktree, own dist dir
//   node bin/task.mjs preview <name>                 build, then serve it on its own port
//   node bin/task.mjs merge <name> [--keep] [--json] verify → build → merge into base (serialised)
//   node bin/task.mjs rm <name> [--force]            drop the worktree (and its branch)
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
    let alive = false;
    try { process.kill(Number(holder), 0); alive = true; } catch { alive = false; }
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
async function cmdNew(raw, base) {
  const name = slug(raw || "");
  if (!name) { console.error("usage: task new <name>"); process.exit(2); }
  const dir = dirFor(name), branch = branchFor(name);
  if (fs.existsSync(dir)) { console.error(`task "${name}" already exists at ${dir}`); process.exit(2); }
  const from = base || currentBranch();
  fs.mkdirSync(TREES, { recursive: true });

  const exists = tryGit(["rev-parse", "--verify", branch]).ok;
  const r = exists
    ? tryGit(["worktree", "add", dir, branch])
    : tryGit(["worktree", "add", "-b", branch, dir, from]);
  if (!r.ok) { console.error(r.out); process.exit(1); }

  // Remember the base in the worktree's own config, so `merge` never has to guess where to land.
  tryGit(["config", "minami.base", from], { cwd: dir });

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
      tasks: tasks.map((t) => ({ ...t, live: live === null ? null : live.has(t.cwd), lastCommitTs: lastCommitTs(t.cwd) })),
    }));
    return;
  }
  if (!tasks.length) { console.log("no tasks. create one:  node bin/task.mjs new <name>"); return; }
  console.log(`${tasks.length} task(s)   base repo: ${ROOT} (${currentBranch()}${isDirty(ROOT) ? ", dirty" : ""})\n`);
  for (const t of tasks) {
    const agent = live === null ? "" : live.has(t.cwd) ? "  ● agent live" : "";
    console.log(`${t.name.padEnd(22)} ${t.branch.padEnd(26)} +${String(t.ahead).padStart(3)} commits  :${t.port}${t.dirty ? "  ✎ uncommitted" : ""}${agent}`);
  }
  if (live === null) console.log("\n(dashboard not reachable on :3000 — live-agent column omitted)");
}

async function cmdBuild(name, { quiet = false } = {}) {
  const dir = dirFor(name);
  if (!fs.existsSync(dir)) { console.error(`no task "${name}"`); process.exit(2); }
  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    // Worktrees share git objects, never node_modules. Symlinking the base's is deliberate: a full
    // install per task costs minutes and gigabytes, and every task is the same package.json by
    // construction (it was branched from it). If a task CHANGES dependencies, delete the link and
    // install for real — that is the one case where sharing is wrong.
    const src = path.join(ROOT, "node_modules");
    if (fs.existsSync(src)) { fs.symlinkSync(src, path.join(dir, "node_modules"), "dir"); if (!quiet) console.log("   linked node_modules from the base checkout"); }
  }
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
  if (live && live.has(dir)) {
    say({ ok: false, reason: "agent-live", task: name });
    console.error(`✗ an agent is live in ${name} right now — let it finish before merging.`);
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

function cmdRm(name, force) {
  const dir = dirFor(name);
  if (!fs.existsSync(dir)) { console.error(`no task "${name}"`); process.exit(2); }
  if (isDirty(dir) && !force) {
    console.error(`✗ ${name} has uncommitted changes — use --force to discard them`);
    process.exit(2);
  }
  const branch = currentBranch(dir);
  const r = tryGit(["worktree", "remove", dir, ...(force ? ["--force"] : [])]);
  if (!r.ok) { console.error(r.out); process.exit(1); }
  const d = tryGit(["branch", force ? "-D" : "-d", branch]);
  console.log(`✓ removed ${name}` + (d.ok ? ` and ${branch}` : ` (branch ${branch} kept: ${d.out.trim().split("\n")[0]})`));
}

// --- main -------------------------------------------------------------------------------------------
const [cmd, arg] = process.argv.slice(2);
const has = (f) => process.argv.includes(f);
const val = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };

const help = () => console.log(
  fs.readFileSync(new URL(import.meta.url), "utf8").split("\n")
    .filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));

switch (cmd) {
  case "new": await cmdNew(arg, val("--base")); break;
  case "list": case "ls": await cmdList({ json: has("--json") }); break;
  case "build": await cmdBuild(arg); break;
  case "preview": await cmdPreview(arg); break;
  case "merge": await cmdMerge(arg, has("--keep"), { json: has("--json") }); break;
  case "rm": case "remove": cmdRm(arg, has("--force")); break;
  default: help();
}
