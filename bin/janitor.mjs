#!/usr/bin/env node
// The storage janitor (§32): keeps the Mac's disk above a floor, on its own, and says so when it can't.
//
//   node bin/janitor.mjs                    a pass: tier 1 always, tier 2 when free < lowGB, until targetGB
//   node bin/janitor.mjs --dry              print what a pass would do; deletes nothing
//   node bin/janitor.mjs --why <reason>     nightly | watermark | manual | render-floor (recorded with the run)
//   node bin/janitor.mjs --sample           record today's disk sample (free GB + biggest folders) and exit
//   node bin/janitor.mjs --do docker        a tier-3 action Thomas approved from the bell / the Storage tab
//   node bin/janitor.mjs --slack "<text>"   DM Thomas (the dead-man's switch in lib/autopilot/storage.ts uses it)
//   node bin/janitor.mjs --selftest         assert the deletion guard refuses every protected path
//
// WHY A PLAIN SCRIPT, NOT CODE INSIDE THE AUTOPILOT TICK
// On 2026-10-2x the disk sat at 3.3 GB free while five renders failed "need 6 GB", and nothing told anyone:
// the one cleanup that ran (Video Studio's tidy) only knew its own renders, freed 0.0 GB and moved on. The
// dashboard restarts on every deploy, so a cleaner that lives in next-server is exactly as reliable as the
// server. This file runs from three places — the autopilot tick when free space crosses lowGB, a nightly
// launchd job (com.thomas.minami-janitor) that works with the server down, and by hand — and it is the
// only thing on the box that deletes for storage. The autopilot only decides WHEN.
//
// THE TIERS (what may go without asking is decided here, nowhere else)
//   1 · regenerable, always: leaked temp dirs, `.next/dev` + `.next/cache` of idle apps, stale worktree
//       records; package caches only when below lowGB.
//   2 · reversible, below lowGB (and nightly): each project's own tidy (its retention rules, not ours);
//       idle worktrees — clean ones removed (the branch keeps every commit), dirty ones first saved as a WIP
//       commit on their branch; the per-repo worktree cap; node_modules idle ≥ N days with a lockfile.
//   3 · asks: Docker, whole folders, unmerged branches, retention. Written to asks.json, never done here
//       unless Thomas pressed the button (`--do`).
// It never merges anything: merging is autopilot's merge duty, behind task.mjs's gates (§13). A worktree
// removed here keeps its branch, and the ledger line says how to bring it back.
//
// NEVER TOUCHED — enforced by assertDeletable(), not by care: browser profiles, cookies and logins, the
// harness browsers (~/.harness, ms-playwright), Keychains, ~/Library outside $TMPDIR, the vault.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { emit } from "./minami-event.mjs";

const HOME = os.homedir();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.env.MINAMI_JANITOR_DIR || path.join(HOME, ".minami", "janitor");
const F = {
  config: path.join(HOME, ".minami", "janitor.json"),
  ledger: path.join(DIR, "ledger.jsonl"),     // one line per thing removed: path, bytes, why, how to restore
  runs: path.join(DIR, "runs.jsonl"),         // one line per pass: free before/after, freed, errors
  disk: path.join(DIR, "disk.jsonl"),         // one sample a day: free GB + the biggest folders (the trend)
  asks: path.join(DIR, "asks.json"),          // tier 3: what only Thomas can decide, with sizes
  lock: path.join(DIR, "run.lock"),
  alerted: path.join(DIR, "alerted.json"),    // the last disk alert sent: which state, when, at what free GB
};
const AUTOPILOT = process.env.MINAMI_AUTOPILOT_CONFIG || path.join(HOME, ".minami", "autopilot.json");
const GB = 2 ** 30; // GiB, the unit `df -h` prints — the number Thomas has been reading all along
const DAY = 86_400_000;

// Hand-editable at ~/.minami/janitor.json; every key optional. Thomas's target is ~80 GB free (2026-10-22).
const DEFAULTS = {
  lowGB: 40,            // below this, tier 2 runs and the tick starts a pass (Thomas, 2026-10-22: "can drop under 40gb")
  targetGB: 80,         // a pass stops once free space is back here
  criticalGB: 25,       // below this, the bell + a macOS notification, with the tier-3 list
  growthAlertGB: 8,     // a day that loses more than this gets an alert naming what grew
  worktreeCap: 12,      // per repo; past it the least recently used idle ones are recycled
  idleDays: { cache: 1, worktree: 3, nodeModules: 7 },
  tmpPrefixes: ["mix-", "bed-"],  // $TMPDIR dirs our own scripts make (tiktok-studio mix.mjs, music-bed.mjs)
  tmpHours: 6,
  // node_modules that other projects load from without ever cd-ing into them
  protect: ["~/hyperframes", "~/secondBrain", "~/Minami", "~/minami-dashboard"],
  // each project's own cleanup, run as-is: its retention rules are its own (one definition, like task.mjs)
  projectTidy: [{ name: "Video Studio", cwd: "~/tiktok-studio", cmd: ["node", "scripts/tidy.mjs", "--go"] }],
  bigFileMB: 50,        // a dirty worktree holding an untracked file this big is not auto-committed: asks
};
const NEVER = [/\/Library\/(?!.*\/T\/)/, /Cookies/i, /Login Data/i, /Keychain/i, /\/\.harness(\/|$)/, /ms-playwright/,
  /\/secondBrain\/(?!.*\.minami-worktrees\/)(?!.*node_modules)(?!.*\.next)/, /\/\.ssh(\/|$)/, /\/\.claude\/projects/];

// ── args ───────────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = flag("--dry");
const WHY = opt("--why") || "manual";

// ── small helpers ──────────────────────────────────────────────────────────────────────────────────────────
const tilde = (p) => p.replace(/^~(?=\/|$)/, HOME);
const short = (p) => p.replace(HOME, "~");
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const append = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(o) + "\n"); };
function sh(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: o.timeout ?? 120_000, cwd: o.cwd, env: { ...process.env, ...o.env } });
  return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).trim() };
}
const git = (cwd, ...a) => sh("git", ["-C", cwd, ...a]);
export function freeBytes() {
  const s = fs.statfsSync(process.platform === "darwin" ? "/System/Volumes/Data" : "/");
  return s.bavail * s.bsize;
}
function sizeOf(p) {
  const r = sh("du", ["-sk", p], { timeout: 300_000 });
  return r.ok || r.out ? (parseInt(r.out, 10) || 0) * 1024 : 0;
}
const gb = (b) => (b / GB).toFixed(1);

function config() {
  const c = { ...DEFAULTS, ...readJSON(F.config, {}) };
  c.idleDays = { ...DEFAULTS.idleDays, ...(c.idleDays || {}) };
  return c;
}
/** autopilot.json's `storage` switch. Off = watch-only: measure, record, alert — never delete. */
const storageOn = () => { const a = readJSON(AUTOPILOT, {}); return a.enabled === true && a.storage === true; };

function assertDeletable(p) {
  const abs = path.resolve(p);
  const tmp = path.resolve(os.tmpdir());
  const inTmp = abs.startsWith(tmp + path.sep);
  if (!inTmp && !abs.startsWith(HOME + path.sep)) throw new Error(`outside home: ${abs}`);
  if (abs.split(path.sep).length < 4) throw new Error(`too shallow: ${abs}`);
  if (!inTmp && NEVER.some((re) => re.test(abs))) throw new Error(`protected path: ${abs}`);
}

/** Every process's cwd, in one lsof call. A folder some process sits in is in use, whatever its mtimes say. */
function cwds() {
  const r = sh("lsof", ["-d", "cwd", "-Fn"], { timeout: 30_000 });
  return new Set(r.out.split("\n").filter((l) => l.startsWith("n/")).map((l) => l.slice(1)));
}
// Folders Docker containers use. A container's processes live in Docker's VM, so lsof never sees them: a project a
// running `docker compose up` bind-mounts would look idle and lose its node_modules or its worktree underneath the
// container (Thomas, 2026-10-22: "when I activate docker — will it mess up since docker is not in the equation").
// Matched in BOTH directions: a mount of ~/ecvision covers ~/ecvision/frontend, and a mount of ~/ecvision/frontend
// makes ~/ecvision in use too.
let DOCKER = [];
const inUse = (dir, used) => {
  for (const c of used) if (c === dir || c.startsWith(dir + "/")) return true;
  for (const d of DOCKER) if (d === dir || d.startsWith(dir + "/") || dir.startsWith(d + "/")) return true;
  return false;
};

/** What running containers mount. Docker up but not answering (it hangs on this box) → every project with a compose
 *  file counts as in use: we can't see what's running, and keeping is the safe wrong answer. */
function dockerPaths() {
  if (!sh("pgrep", ["-f", "com.docker.backend"]).ok) return { up: false, paths: [] };
  const ids = sh("docker", ["ps", "-q"], { timeout: 15_000 });
  if (ids.ok) {
    const list = ids.out.split("\n").filter((x) => /^[0-9a-f]{6,}$/.test(x));
    if (!list.length) return { up: true, paths: [] };
    const fmt = '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}\n{{end}}{{end}}{{index .Config.Labels "com.docker.compose.project.working_dir"}}\n';
    const ins = sh("docker", ["inspect", "--format", fmt, ...list], { timeout: 15_000 });
    if (ins.ok) return { up: true, paths: [...new Set(ins.out.split("\n").map((x) => x.trim()).filter((x) => x.startsWith("/")))] };
  }
  const composes = sh("find", [HOME, "-xdev", "-maxdepth", "4", "(", "-name", "Library", "-o", "-name", "node_modules", "-o", "-name", ".git", ")",
    "-prune", "-o", "-type", "f", "(", "-name", "docker-compose*.yml", "-o", "-name", "docker-compose*.yaml", "-o", "-name", "compose.y*ml", ")", "-print"],
    { timeout: 120_000 }).out.split("\n").filter((l) => l.startsWith("/"));
  // the repo root, not the compose file's folder: ecvision keeps its compose in infra/ and mounts ../frontend
  const roots = composes.map((c) => { const t = git(path.dirname(c), "rev-parse", "--show-toplevel"); return t.ok && t.out.startsWith("/") ? t.out : path.dirname(c); });
  return { up: true, hung: true, paths: [...new Set(roots)] };
}

/** Newest mtime under `dir`, skipping regenerables, at most `depth` levels and `cap` entries. */
function newest(dir, depth = 4, skip = new Set(["node_modules", ".next", ".git", "dist", "out", ".turbo"])) {
  let best = 0, seen = 0;
  const walk = (d, n) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++seen > 20_000) return;
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      try { const m = fs.lstatSync(p).mtimeMs; if (m > best) best = m; } catch { continue; }
      if (e.isDirectory() && n < depth) walk(p, n + 1);
    }
  };
  walk(dir, 0);
  return best;
}

/** `find` with prunes — the home tree is ~200k dirs and node_modules is most of them. */
function findDirs(name, maxdepth) {
  // the name being searched for must not be in the prune list, or find prunes it before it can match
  const prune = ["Library", ".Trash", "node_modules", ".git", ".cache", ".npm", ".claude"].filter((n) => n !== name);
  const expr = prune.flatMap((n, i) => [...(i ? ["-o"] : []), "-name", n]);
  const r = sh("find", [HOME, "-xdev", "-maxdepth", String(maxdepth), "(", ...expr, ")", "-prune", "-o",
    "-type", "d", "-name", name, "-print", "-prune"], { timeout: 300_000 });
  return r.out.split("\n").filter((l) => l.startsWith("/") && l.endsWith("/" + name));
}

// ── the run ────────────────────────────────────────────────────────────────────────────────────────────────
const actions = [];
const errors = [];
let RUN = "";

function remove(p, tier, kind, why, restore) {
  assertDeletable(p);
  const bytes = sizeOf(p);
  if (!DRY) fs.rmSync(p, { recursive: true, force: true });
  const a = { at: new Date().toISOString(), run: RUN, tier, kind, path: short(p), bytes, why, restore, dry: DRY || undefined };
  actions.push(a);
  if (!DRY) append(F.ledger, a);
  return bytes;
}
const freedSoFar = () => actions.reduce((t, a) => t + (a.bytes || 0), 0);
const enough = (cfg, start) => (DRY ? start + freedSoFar() : freeBytes()) >= cfg.targetGB * GB;

function tier1(cfg, used, below) {
  // Leaked temp dirs. mix.mjs/music-bed.mjs leaked 81 of these (7.8 GB) before they learned to clean up on exit.
  const tmp = os.tmpdir();
  for (const n of fs.readdirSync(tmp)) {
    if (!cfg.tmpPrefixes.some((p) => n.startsWith(p))) continue;
    const p = path.join(tmp, n);
    try { if (Date.now() - fs.statSync(p).mtimeMs < cfg.tmpHours * 3600e3) continue; } catch { continue; }
    try { remove(p, 1, "tmp", `temp dir older than ${cfg.tmpHours} h`, "regenerated by the script that made it"); }
    catch (e) { errors.push(String(e.message)); }
  }
  // Turbopack's dev cache has no size cap (Next 16.3) and runs 1–3 GB per app; ~15 GB across the box on 2026-10-22.
  for (const nx of findDirs(".next", 8)) {
    const app = path.dirname(nx);
    if (inUse(app, used)) continue;
    for (const sub of ["dev", "cache"]) {
      const p = path.join(nx, sub);
      if (!fs.existsSync(p)) continue;
      if (Date.now() - newest(p, 2) < cfg.idleDays.cache * DAY) continue;
      try { remove(p, 1, "next-cache", `${sub} cache of an idle Next app`, "rebuilt by the next `next dev` / build"); }
      catch (e) { errors.push(String(e.message)); }
    }
  }
  for (const repo of worktreeRepos()) if (!DRY) git(repo, "worktree", "prune");
  if (!below) return;
  const before = freeBytes();
  const caches = [["npm", ["cache", "clean", "--force"]], ["pnpm", ["store", "prune"]], ["uv", ["cache", "prune"]],
    ["brew", ["cleanup", "-s"]]];
  for (const [c, a] of caches) {
    if (!sh("which", [c]).ok) continue;
    if (DRY) { actions.push({ tier: 1, kind: "pkg-cache", path: `${c} ${a.join(" ")}`, bytes: 0, why: "below lowGB", dry: true }); continue; }
    // uv's cache lock is held for as long as any `uvx` runs, and the StoreLeads Grafana MCP is a long-lived uvx: without
    // a short timeout every pass sat 300 s on it and then gave up anyway (2026-10-27).
    const r = sh(c, a, { timeout: 600_000, env: c === "uv" ? { UV_LOCK_TIMEOUT: "10" } : undefined });
    if (!r.ok) errors.push(`${c}: ${r.out.split("\n").pop()}`);
  }
  if (!DRY) {
    const a = { at: new Date().toISOString(), run: RUN, tier: 1, kind: "pkg-cache", path: "npm · pnpm · uv · brew",
      bytes: Math.max(0, freeBytes() - before), why: "below lowGB", restore: "re-downloaded on the next install" };
    actions.push(a); append(F.ledger, a);
  }
}

/** Repos that hold Minami worktrees: the dashboard makes one per chat in whichever repo the chat is in. */
function worktreeRepos() {
  return findDirs(".minami-worktrees", 4).map((d) => path.dirname(d)).filter((r) => fs.existsSync(path.join(r, ".git")));
}

function claimLive(wt) {
  const f = path.join(wt, ".minami-claim.json");
  if (!fs.existsSync(f)) return false;
  const c = readJSON(f, null);
  const hb = Number(c?.heartbeatAt);
  if (!hb) return true; // unparseable → assume live; keeping is the safe wrong answer (prune-worktrees.sh)
  return Date.now() - hb < 30 * 60_000;
}

function worktreesOf(repo) {
  const out = git(repo, "worktree", "list", "--porcelain").out;
  return out.split("\n\n").map((b) => {
    const p = b.match(/^worktree (.+)$/m)?.[1];
    return { path: p, branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] || null, locked: /^locked/m.test(b) };
  }).filter((w) => w.path && w.path.includes("/.minami-worktrees/"));
}

/** Last time anyone worked in a worktree: the newest of its last commit and its changed files. */
function lastWork(wt) {
  const commit = Number(git(wt, "log", "-1", "--format=%ct").out) * 1000 || 0;
  const changed = git(wt, "status", "--porcelain", "-uall").out.split("\n").filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, "")).filter((f) => f !== ".minami-claim.json");
  let m = commit;
  for (const f of changed.slice(0, 500)) { try { m = Math.max(m, fs.lstatSync(path.join(wt, f)).mtimeMs); } catch {} }
  return { at: m || newest(wt, 3), changed };
}

const midOperation = (wt) => {
  const gd = git(wt, "rev-parse", "--absolute-git-dir").out;
  return ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "BISECT_LOG"].some((f) => fs.existsSync(path.join(gd, f)));
};

/** Save a worktree's uncommitted work as a commit on its own branch, then remove the folder. Never merges. */
function recycle(repo, w, cfg, why) {
  const { changed } = lastWork(w.path);
  let branch = w.branch;
  const big = changed.find((f) => { try { return fs.statSync(path.join(w.path, f)).size > cfg.bigFileMB * 2 ** 20; } catch { return false; } });
  if (big) return ask({ id: `wt:${short(w.path)}`, title: `Worktree ${short(w.path)} holds a large unsaved file`,
    detail: `${big} is over ${cfg.bigFileMB} MB, so it wasn't auto-committed. Commit, move or delete it by hand.`, gb: 0 });
  let saved = "";
  if (changed.length) {
    if (!DRY) {
      if (!branch) { branch = `wip/${path.basename(w.path)}-${new Date().toISOString().slice(0, 10)}`; git(w.path, "switch", "-q", "-c", branch); }
      fs.rmSync(path.join(w.path, ".minami-claim.json"), { force: true });
      git(w.path, "add", "-A");
      const c = git(w.path, "commit", "-q", "--no-verify", "-m",
        `wip: uncommitted work saved by the storage janitor\n\nThe worktree was recycled to free disk (${why}). Nothing merged.\n` +
        `Resume: git worktree add ${short(w.path)} ${branch}`);
      if (!c.ok) { errors.push(`commit ${short(w.path)}: ${c.out.split("\n").pop()}`); return 0; }
      saved = ` (${changed.length} uncommitted file(s) saved as ${git(w.path, "rev-parse", "--short", "HEAD").out} on ${branch})`;
    } else saved = ` (${changed.length} uncommitted file(s) would be saved on ${branch || "a new wip/ branch"})`;
  }
  if (!branch) { errors.push(`skip ${short(w.path)}: detached HEAD with nothing to save, left for a human`); return 0; }
  const bytes = sizeOf(w.path);
  assertDeletable(w.path);
  if (!DRY) {
    // no --force: if anything changed since the save commit (a session came back), git refuses and the tree stays
    const r = git(repo, "worktree", "remove", w.path);
    if (!r.ok) { errors.push(`remove ${short(w.path)}: ${r.out.split("\n").pop()}`); return 0; }
  }
  const a = { at: new Date().toISOString(), run: RUN, tier: 2, kind: "worktree", path: short(w.path), bytes,
    why: why + saved, restore: `git -C ${short(repo)} worktree add ${short(w.path)} ${branch}`, dry: DRY || undefined };
  actions.push(a);
  if (!DRY) append(F.ledger, a);
  return bytes;
}

function tier2(cfg, used, start) {
  // Each project's own tidy first: its retention is a promise it made Thomas, and it knows what's posted.
  for (const t of cfg.projectTidy) {
    const cwd = tilde(t.cwd);
    if (!fs.existsSync(cwd)) continue;
    if (DRY) { actions.push({ tier: 2, kind: "project-tidy", path: t.name, bytes: 0, why: t.cmd.join(" "), dry: true }); continue; }
    const before = freeBytes();
    const r = sh(t.cmd[0], t.cmd.slice(1), { cwd, timeout: 900_000 });
    if (!r.ok) errors.push(`${t.name} tidy: ${r.out.split("\n").pop()}`);
    const a = { at: new Date().toISOString(), run: RUN, tier: 2, kind: "project-tidy", path: t.name,
      bytes: Math.max(0, freeBytes() - before), why: "the project's own retention rules", restore: "renders re-made from their cached sources" };
    actions.push(a); append(F.ledger, a);
  }
  if (enough(cfg, start)) return;

  // Worktrees: idle + unoccupied → recycled (work saved on its branch first). Past the cap, the least recently
  // used go even if younger than idleDays — but never one a live session claims or a process sits in.
  for (const repo of worktreeRepos()) {
    const trees = worktreesOf(repo).map((w) => ({ ...w, last: lastWork(w.path).at }))
      .filter((w) => !w.locked && !claimLive(w.path) && !inUse(w.path, used) && !midOperation(w.path))
      .sort((a, b) => a.last - b.last);
    const total = worktreesOf(repo).length;
    let over = Math.max(0, total - cfg.worktreeCap);
    for (const w of trees) {
      const idle = Date.now() - w.last;
      const stale = idle >= cfg.idleDays.worktree * DAY;
      const capped = over > 0 && idle >= DAY;
      if (!stale && !capped) continue;
      try { recycle(repo, w, cfg, stale ? `idle ${Math.round(idle / DAY)} d` : `over the ${cfg.worktreeCap}-worktree cap`); }
      catch (e) { errors.push(String(e.message)); }
      if (capped) over--;
    }
  }
  if (enough(cfg, start)) return;

  // node_modules idle ≥ N days, only where a lockfile can bring back exactly what was there.
  const protect = cfg.protect.map(tilde);
  for (const nm of findDirs("node_modules", 6)) {
    const proj = path.dirname(nm);
    if (protect.some((p) => proj === p || proj.startsWith(p + "/"))) continue;
    if (inUse(proj, used)) continue;
    const top = git(proj, "rev-parse", "--show-toplevel").out || proj;
    const locks = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
    const hasLock = [proj, top].some((d) => locks.some((l) => fs.existsSync(path.join(d, l))));
    if (!hasLock) continue;
    if (Date.now() - newest(top.startsWith("/") ? top : proj, 3) < cfg.idleDays.nodeModules * DAY) continue;
    try { remove(nm, 2, "node_modules", `project idle ≥ ${cfg.idleDays.nodeModules} d`, `npm install (lockfile in ${short(top)})`); }
    catch (e) { errors.push(String(e.message)); }
    if (enough(cfg, start)) return;
  }
}

// ── tier 3: what only Thomas decides ──────────────────────────────────────────────────────────────────────
const asks = [];
function ask(a) { asks.push(a); return 0; }
function tier3() {
  const raw = path.join(HOME, "Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw");
  if (fs.existsSync(raw)) {
    const b = sizeOf(raw);
    if (b > 5 * GB) ask({ id: "docker", title: `Docker holds ${gb(b)} GB`, gb: +gb(b), action: "docker",
      detail: "Removes images no container uses and the build cache, then gives the space back to macOS. " +
        "Containers (running or stopped) and their volumes are never touched by this button." });
  }
  fs.mkdirSync(DIR, { recursive: true });
  if (!DRY) fs.writeFileSync(F.asks, JSON.stringify({ at: new Date().toISOString(), asks }, null, 2));
}

function doDocker() {
  const ping = sh("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 20_000 });
  if (!ping.ok) return { ok: false, msg: "Docker isn't answering. Open Docker Desktop (or restart it), then press again." };
  const before = freeBytes();
  // NOT `system prune`: that also deletes stopped containers (a stopped database is still somebody's database).
  // `image prune -a` keeps every image a container — running or stopped — still references. Volumes: never.
  const p = sh("docker", ["image", "prune", "-af"], { timeout: 900_000 });
  sh("docker", ["builder", "prune", "-af"], { timeout: 900_000 });
  sh("docker", ["run", "--rm", "--privileged", "--pid=host", "docker/desktop-reclaim-space"], { timeout: 900_000 });
  const freed = Math.max(0, freeBytes() - before);
  append(F.ledger, { at: new Date().toISOString(), run: RUN, tier: 3, kind: "docker", path: "docker image prune -af + builder prune + reclaim",
    bytes: freed, why: "approved by Thomas", restore: "images re-pulled on next use; volumes untouched" });
  return { ok: p.ok, msg: `Docker cleaned: ${gb(freed)} GB back to macOS.` };
}

// ── the trend ──────────────────────────────────────────────────────────────────────────────────────────────
function sample() {
  const today = new Date().toISOString().slice(0, 10);
  const lines = fs.existsSync(F.disk) ? fs.readFileSync(F.disk, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  if (lines.at(-1)?.date === today) return lines;
  const top = [];
  for (const n of fs.readdirSync(HOME)) {
    const p = path.join(HOME, n);
    try { if (!fs.lstatSync(p).isDirectory() || n === "Library") continue; } catch { continue; }
    top.push({ path: short(p), gb: +(sizeOf(p) / GB).toFixed(2) });
  }
  for (const p of ["Library/Containers", "Library/Application Support", "Library/Caches"]) {
    top.push({ path: "~/" + p, gb: +(sizeOf(path.join(HOME, p)) / GB).toFixed(2) });
  }
  top.push({ path: "$TMPDIR", gb: +(sizeOf(os.tmpdir()) / GB).toFixed(2) });
  top.sort((a, b) => b.gb - a.gb);
  const s = { date: today, at: new Date().toISOString(), freeGB: +gb(freeBytes()), top: top.slice(0, 15) };
  append(F.disk, s);
  return [...lines, s];
}

async function growthCheck(cfg, lines) {
  if (lines.length < 2) return;
  const [y, t] = lines.slice(-2);
  const lost = y.freeGB - t.freeGB;
  const days = Math.max(1, Math.round((Date.parse(t.at) - Date.parse(y.at)) / DAY));
  if (lost / days < cfg.growthAlertGB) return;
  const prev = new Map(y.top.map((x) => [x.path, x.gb]));
  const grew = t.top.map((x) => ({ ...x, d: x.gb - (prev.get(x.path) ?? 0) })).filter((x) => x.d > 0.5).sort((a, b) => b.d - a.d).slice(0, 4);
  await emit({ kind: "storage", level: "warn", title: `Disk lost ${lost.toFixed(0)} GB since ${y.date}`,
    body: `Free: ${y.freeGB} → ${t.freeGB} GB.\nGrew most: ${grew.map((g) => `${g.path} +${g.d.toFixed(1)} GB`).join(", ") || "nothing in the sampled folders (system data or Docker?)"}` });
}

/** A Slack DM to Thomas through Minami's bot — the helper Video Studio already uses for its night alerts (it reads the
 *  token from ~/Minami/.env and never prints it). Only for what needs him: critical, and "couldn't free". Best effort. */
async function slack(text) {
  const helper = path.join(HOME, "tiktok-studio/scripts/lib/slack.mjs");
  if (!fs.existsSync(helper)) return;
  try { const { notify: dm } = await import(helper); await dm(text); } catch { /* the bell already has it */ }
}

/** Whether a disk alert is news. The tick starts a pass every 20 min while free space is under the floor, and each pass
 *  is a fresh process, so without a memory on disk a disk that just sits at 31 GB DM'd Thomas 35 times overnight
 *  (2026-10-26/27). Speak on entering a state, on getting worse by 5 GB, on stuck → critical, or once a day. */
const RANK = { stuck: 1, critical: 2 };
function isNews(state, freeGB) {
  const last = readJSON(F.alerted, null);
  const news = !last || RANK[state] > (RANK[last.state] ?? 0) || last.freeGB - freeGB >= 5 || Date.now() - Date.parse(last.at) > DAY;
  if (news) fs.writeFileSync(F.alerted, JSON.stringify({ state, at: new Date().toISOString(), freeGB: +freeGB.toFixed(1) }));
  return news;
}

const DK = (ps) => ps.map(short).join(", ");

function notify(title, body) {
  sh("osascript", ["-e", `display notification ${JSON.stringify(body.slice(0, 180))} with title ${JSON.stringify(title)}`], { timeout: 10_000 });
}

/** The guard is the product: Claude Code's own worktree sweep was reported deleting dirty, unpushed work its
 *  docs said it kept (anthropics/claude-code#74719). So the refusals are asserted, not assumed. Exit 1 on a miss. */
function selftest() {
  const must = (p, ok) => { let threw = false; try { assertDeletable(p); } catch { threw = true; } return threw === !ok ? null : `${ok ? "refused" : "allowed"} ${p}`; };
  const T = os.tmpdir();
  const fails = [
    must(`${HOME}/Library/Application Support/Google/Chrome/Default/Cookies`, false),
    must(`${HOME}/Library/Application Support/Google/Chrome/Default`, false),
    must(`${HOME}/Library/Keychains/login.keychain-db`, false),
    must(`${HOME}/Library/Caches/ms-playwright/chromium-1`, false),
    must(`${HOME}/.harness/profiles/x`, false),
    must(`${HOME}/secondBrain/60-69 Wiki/note.md`, false),
    must(`${HOME}/.claude/projects/-Users-thomas/x.jsonl`, false),
    must(`${HOME}/.ssh/id_ed25519`, false),
    must(`/etc/hosts`, false),
    must(HOME, false),
    must(`${T}/mix-abc`, true),
    must(`${HOME}/ecvision/frontend/.next/dev`, true),
    must(`${HOME}/secondBrain/70-79 Toolshed/tools/design-kit/.next/dev`, true),
    must(`${HOME}/ecvision/.minami-worktrees/chat-5`, true),
  ].filter(Boolean);
  for (const f of fails) console.log(`✗ ${f}`);
  console.log(fails.length ? `selftest: ${fails.length} guard failure(s)` : "✓ selftest: every protected path refused, every cleanable one allowed");
  if (fails.length) process.exitCode = 1;
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const cfg = config();
  if (flag("--sample")) { await growthCheck(cfg, sample()); return; }
  if (flag("--selftest")) return selftest();
  if (opt("--slack")) return slack(opt("--slack")); // storage.ts's dead-man's switch speaks through this

  // One pass at a time. A lock older than 2 h is a pass that died; take it over.
  const lk = readJSON(F.lock, null);
  if (lk && Date.now() - lk.at < 2 * 3600e3 && sh("kill", ["-0", String(lk.pid)]).ok) { console.log(`a pass is already running (pid ${lk.pid})`); return; }
  fs.writeFileSync(F.lock, JSON.stringify({ pid: process.pid, at: Date.now(), why: WHY }));
  RUN = `${new Date().toISOString().slice(0, 16)}-${WHY}`;
  const t0 = Date.now();
  const start = freeBytes();
  try {
    if (opt("--do") === "docker") {
      const r = doDocker();
      await emit({ kind: "storage", level: r.ok ? "success" : "warn", title: r.msg, body: "" });
      console.log(r.msg);
      return;
    }
    const on = storageOn() || flag("--force-on");
    const below = start < cfg.lowGB * GB;
    const used = cwds();
    const dk = dockerPaths();
    DOCKER = dk.paths;
    if (dk.hung) errors.push(`Docker is running but not answering: left ${DK(dk.paths)} alone`);
    else if (dk.paths.length) console.log(`docker: ${dk.paths.length} folder(s) mounted by running containers, kept`);
    if (on || DRY) {
      tier1(cfg, used, below);
      if ((below || WHY === "nightly" || WHY === "render-floor") && !enough(cfg, start)) tier2(cfg, used, start);
    }
    tier3();
    const end = DRY ? start + freedSoFar() : freeBytes();
    const run = { at: new Date().toISOString(), run: RUN, why: WHY, dry: DRY || undefined, watchOnly: !on && !DRY || undefined,
      freeBeforeGB: +gb(start), freeAfterGB: +gb(end), freedGB: +gb(Math.max(0, end - start)),
      actions: actions.length, errors: errors.slice(0, 10), ms: Date.now() - t0 };
    if (!DRY) append(F.runs, run);

    // Report. Lines first (the CLI and the logs read these), then the bell.
    const byKind = {};
    for (const a of actions) byKind[a.kind] = (byKind[a.kind] || 0) + (a.bytes || 0);
    for (const [k, b] of Object.entries(byKind)) console.log(`${DRY ? "would free" : "freed"} ${gb(b).padStart(5)} GB  ${k}`);
    for (const a of actions.filter((x) => x.kind === "worktree")) console.log(`  · ${a.path} — ${a.why}`);
    for (const e of errors.slice(0, 10)) console.log(`✗ ${e}`);
    for (const a of asks) console.log(`? ${a.title} — ${a.detail}`);
    console.log(`${DRY ? "dry run" : on ? "pass" : "watch-only (autopilot.storage is off)"}: ${run.freeBeforeGB} → ${run.freeAfterGB} GB free`);
    if (DRY) return;

    const endGB = end / GB;
    if (endGB >= cfg.lowGB) fs.rmSync(F.alerted, { force: true }); // back above the floor: the next dip is news again
    // The exact silent failure of the night five renders died: below the floor, ran, freed nothing.
    const stuck = on && start < cfg.lowGB * GB && end - start < GB;
    if (endGB < cfg.criticalGB) {
      if (isNews("critical", endGB)) {
        const body = `Only ${endGB.toFixed(1)} GB free after the janitor's pass. Waiting on you: ` +
          (asks.map((a) => `${a.title}`).join("; ") || "nothing safe is left to clear automatically") + ". Open /autopilot?tab=storage.";
        await emit({ kind: "storage", level: "error", title: `Disk critical: ${endGB.toFixed(1)} GB free`, body });
        notify("Disk critical", body);
        await slack(`💾 Disk critical: ${endGB.toFixed(1)} GB free. ${body}`);
      }
    } else if (stuck) {
      if (isNews("stuck", endGB)) {
        await emit({ kind: "storage", level: "warn", title: `Janitor couldn't free space: ${endGB.toFixed(1)} GB free`,
          body: `Below the ${cfg.lowGB} GB floor and nothing left in tiers 1–2. ${asks.length ? "Your call: " + asks.map((a) => a.title).join("; ") : ""}` });
        await slack(`💾 The storage janitor couldn't free space: ${endGB.toFixed(1)} GB free (floor ${cfg.lowGB}). ${asks.map((a) => a.title).join("; ")} — /autopilot?tab=storage`);
      }
    } else if (run.freedGB >= 1) {
      await emit({ kind: "storage", level: "success", title: `Janitor freed ${run.freedGB} GB — ${run.freeAfterGB} GB free`,
        body: Object.entries(byKind).map(([k, b]) => `${k} ${gb(b)} GB`).join(" · ") });
    }
    if (errors.length) await emit({ kind: "storage", level: "warn", title: `Janitor: ${errors.length} thing(s) it skipped`, body: errors.slice(0, 5).join("\n") });
    if (WHY === "nightly") await growthCheck(cfg, sample());
  } finally {
    fs.rmSync(F.lock, { force: true });
  }
}

main().catch(async (e) => {
  append(F.runs, { at: new Date().toISOString(), run: RUN, why: WHY, error: String(e?.stack || e).slice(0, 500) });
  await emit({ kind: "storage", level: "error", title: "Storage janitor crashed", body: String(e?.message || e) }).catch(() => {});
  fs.rmSync(F.lock, { force: true });
  console.error(e);
  process.exit(1);
});
