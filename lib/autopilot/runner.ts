// The always-on agent: merges finished task worktrees, resolves the conflicts it safely can, and
// deploys — so that using this dashboard doesn't require knowing what a merge is.
//
// ── Why a timer inside next-server, of all places ────────────────────────────────────────────────
// The awkward fact is that this thing lives inside the process its own deploys kill. Three
// consequences shape everything below:
//   · its switch lives on DISK (lib/autopilot/config.ts), so a restart it caused can read it back;
//   · it never deploys inline — `deploy.sh --detach` already knows how to outlive its requester;
//   · it must assume it can die at ANY point, including with a conflicted merge half-resolved. Hence
//     the claim file and `recoverFromCrash()`, which run before the first tick.
//
// ── The one invariant ────────────────────────────────────────────────────────────────────────────
// **Never leave the base checkout mid-merge.** A conflicted merge leaves every other agent in that
// tree working on a broken state, and nothing else on the box will tell them. Every failure path here
// ends in either a completed commit or `git merge --abort`. That is worth more than any merge this
// ever lands: a missed merge costs a click, an abandoned conflict costs a morning.
//
// ── What it will not do ──────────────────────────────────────────────────────────────────────────
// It doesn't decide *intent*. A conflict where both sides implemented the same behaviour differently
// is aborted and handed back, because picking one is a product decision wearing a diff's clothing.
// It resolves the mechanical kind — both sides appended to a changelog, added rows to a table, edited
// different functions in one file — and it proves the result compiles before committing it.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfig } from "./config";

const exec = promisify(execFile);

const CLAIM_FILE = path.join(os.homedir(), ".minami", "autopilot-merge.json");
const MERGE_LOCK = "/tmp/minami-merge.lock";
const DEPLOY_LOCK = "/tmp/minami-deploy.lock";
const RESOLVE_KEY = "autopilot:resolve";     // the pane key the resolver session runs under
const RESOLVE_TIMEOUT_MS = 6 * 60_000;

type TaskRow = {
  name: string; cwd: string; branch: string; base: string; ahead: string;
  dirty: boolean; live: boolean | null; lastCommitTs: number;
};
type ListOut = {
  base: { root: string; branch: string; dirty: boolean; merging: boolean };
  liveKnown: boolean;
  tasks: TaskRow[];
};

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;                       // one tick at a time, always
const blocked = new Map<string, string>(); // task → why a human is needed. Never retried automatically.
let lastComplaint = 0;                     // alert-storm guard for recurring, non-actionable states

/** Where the MAIN checkout is. A worktree preview server must never drive merges into its own tree —
 *  `git-common-dir` points every worktree at the one real `.git`, whose parent is the base. */
async function mainRoot(): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: process.cwd() });
    const gitDir = stdout.trim();
    if (!gitDir) return null;
    const root = path.dirname(gitDir);
    // If our own cwd isn't that root, we're running inside a worktree preview — stay out of it.
    return path.resolve(process.cwd()) === path.resolve(root) ? root : null;
  } catch { return null; }
}

const git = (root: string, args: string[]) => exec("git", args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
const held = (lock: string) => fs.existsSync(lock);

async function emit(kind: string, level: string, title: string, body = "") {
  // Through the CLI writer, deliberately: it is the only writer of the event log, and it is a separate
  // process, so an alert about a deploy survives the deploy. See bin/minami-event.mjs.
  try {
    await exec(process.execPath, [path.join(process.cwd(), "bin", "minami-event.mjs"), kind, level, title, body]);
  } catch { /* an alert that fails to record must never break the thing it describes */ }
}

/** Alerts about a state that persists (a dirty base, say) would otherwise fire on every tick. */
async function complain(kind: string, level: string, title: string, body: string, everyMs = 30 * 60_000) {
  if (Date.now() - lastComplaint < everyMs) return;
  lastComplaint = Date.now();
  await emit(kind, level, title, body);
}

const readClaim = (): { task: string; startedAt: number } | null => {
  try { return JSON.parse(fs.readFileSync(CLAIM_FILE, "utf8")); } catch { return null; }
};
const claim = (task: string) => {
  fs.mkdirSync(path.dirname(CLAIM_FILE), { recursive: true });
  fs.writeFileSync(CLAIM_FILE, JSON.stringify({ task, startedAt: Date.now() }));
};
const unclaim = () => { try { fs.rmSync(CLAIM_FILE, { force: true }); } catch { /* ignore */ } };

/**
 * Did we die holding a conflicted merge? Runs once, before the first tick.
 *
 * Only aborts a merge THIS agent started (the claim file). A human's half-finished resolution is
 * theirs; throwing it away because a server restarted would be its own incident.
 */
export async function recoverFromCrash(): Promise<void> {
  const c = readClaim();
  if (!c) return;
  const root = await mainRoot();
  if (!root) { unclaim(); return; }
  const merging = fs.existsSync(path.join(root, ".git", "MERGE_HEAD"));
  unclaim();
  if (!merging) return; // it finished before we died — nothing to undo
  await git(root, ["merge", "--abort"]).catch(() => {});
  await emit("autopilot", "warn", `Autopilot recovered a half-finished merge — ${c.task}`,
    `The server restarted while ${c.task} was mid-merge, so the merge was rolled back and the checkout is clean again.\n` +
    `Nothing was lost: the task's branch still has every commit. It will be retried on the next pass.`);
}

async function listTasks(root: string): Promise<ListOut | null> {
  try {
    const { stdout } = await exec(process.execPath, [path.join(root, "bin", "task.mjs"), "list", "--json"], { cwd: root });
    return JSON.parse(stdout);
  } catch { return null; }
}

/** Leftover conflict markers are the failure an agent is most likely to hand back looking finished. */
async function hasMarkers(root: string): Promise<boolean> {
  try {
    // -I is not portable enough to rely on; grep the tracked files git says changed in this merge.
    const { stdout } = await git(root, ["diff", "--name-only", "HEAD"]);
    for (const f of stdout.split("\n").filter(Boolean)) {
      let text = "";
      try { text = fs.readFileSync(path.join(root, f), "utf8"); } catch { continue; }
      if (/^<{7} |^={7}$|^>{7} /m.test(text)) return true;
    }
    return false;
  } catch { return true; } // can't prove it's clean → treat as dirty
}

/**
 * Hand a conflict to a real agent, then CHECK ITS WORK. Nothing here trusts the session's own account
 * of what it did — the same rule the deploy follows when it judges success on a changed PID rather
 * than on exit 0.
 */
async function resolveConflict(root: string, task: string, files: string[]): Promise<boolean> {
  const { sendMessage, isBusy } = await import("@/lib/agent/manager");
  const prompt = [
    `You are resolving a git merge conflict in ${root}. The merge of task branch "${task}" is already`,
    `in progress and stopped on these files:`,
    ...files.map((f) => `  - ${f}`),
    ``,
    `Resolve ONLY if the conflict is mechanical — both sides appended to a list or changelog, added`,
    `separate rows to a table, or edited different functions in the same file. Keep BOTH sides' intent.`,
    ``,
    `If resolving would mean choosing between two real implementations of the same behaviour, or you`,
    `would be guessing at intent: run \`git merge --abort\` and say ABORTED. That is a good outcome,`,
    `not a failure.`,
    ``,
    `Do NOT commit. Do NOT deploy. Leave every file staged and free of conflict markers, then stop.`,
    `Something else verifies the result and commits it.`,
  ].join("\n");

  sendMessage({ key: RESOLVE_KEY, cwd: root, message: prompt });

  const until = Date.now() + RESOLVE_TIMEOUT_MS;
  // Give it a beat to actually start, or "not busy yet" reads as "already finished".
  await new Promise((r) => setTimeout(r, 5_000));
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5_000));
    let busy = false;
    try { busy = isBusy(RESOLVE_KEY); } catch { busy = false; }
    if (busy) continue;
    // It stopped. Whether it says it succeeded is not the question — what's on disk is.
    const unmerged = (await git(root, ["ls-files", "-u"]).catch(() => ({ stdout: "x" }))).stdout.trim();
    const stillMerging = fs.existsSync(path.join(root, ".git", "MERGE_HEAD"));
    if (!stillMerging) return false;          // it aborted, as instructed — an honest no
    if (unmerged) return false;               // stopped with conflicts still unstaged
    if (await hasMarkers(root)) return false; // "resolved" with markers left in the file
    return true;
  }
  return false; // timed out
}

/** The build gate, in the base checkout, into a dist dir that never touches the live one. */
async function buildsClean(root: string): Promise<boolean> {
  try {
    await exec("npx", ["next", "build"], { cwd: root, env: { ...process.env, NEXT_DIST_DIR: ".next-verify" }, timeout: 8 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    return true;
  } catch { return false; }
}

async function tick(): Promise<void> {
  if (ticking) return;
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.merge) return;
  if (process.env.MINAMI_AUTOPILOT_DISABLE === "1") return;

  ticking = true;
  try {
    const root = await mainRoot();
    if (!root) return;
    // Someone else is mid-merge or mid-deploy. Both are serialised for good reasons; queue behind them.
    if (held(MERGE_LOCK) || held(DEPLOY_LOCK)) return;

    const state = await listTasks(root);
    if (!state) return;

    if (state.base.merging) {
      // Not ours (recoverFromCrash already handled ours) — a human is mid-merge. Say nothing, do less.
      await complain("autopilot", "warn", "Autopilot is waiting — the checkout is mid-merge",
        "Someone is resolving a merge by hand. Autopilot won't touch the checkout until that's finished or aborted.");
      return;
    }
    if (state.base.dirty) {
      await complain("autopilot", "info", "Autopilot is waiting — uncommitted changes in the main checkout",
        "Merging into a checkout with uncommitted work risks losing it. Commit or discard what's there and autopilot will carry on.");
      return;
    }
    // `live === null` means the dashboard couldn't be reached to ask. Unknown is not "no".
    if (!state.liveKnown) return;

    const now = Date.now();
    const ready = state.tasks.filter((t) =>
      !t.dirty && Number(t.ahead) > 0 && t.live === false &&
      !blocked.has(t.name) && t.lastCommitTs > 0 && now - t.lastCommitTs > cfg.settleMs);
    if (!ready.length) return;

    // Oldest settled first: the one most likely to be genuinely finished, and it keeps the order
    // predictable to anyone watching.
    ready.sort((a, b) => a.lastCommitTs - b.lastCommitTs);
    const t = ready[0];

    claim(t.name);
    let out = "";
    let merged = false;
    try {
      const r = await exec(process.execPath, [path.join(root, "bin", "task.mjs"), "merge", t.name, "--json"], { cwd: root });
      out = r.stdout;
      merged = true;
    } catch (e) {
      out = String((e as { stdout?: string }).stdout || "");
    }
    const result = (() => { try { return JSON.parse(out.trim().split("\n").pop() || "{}"); } catch { return {}; } })();

    if (!merged && result.reason === "conflict") {
      const files: string[] = result.files || [];
      let ok = false;
      if (cfg.resolve) {
        await emit("autopilot", "info", `Autopilot is resolving a conflict — ${t.name}`,
          `${files.length} file(s) conflicted. It will only resolve mechanical overlaps, and will roll the merge back if it can't.`);
        ok = await resolveConflict(root, t.name, files);
        if (ok) ok = await buildsClean(root);
        if (ok) {
          await git(root, ["commit", "--no-edit"]).catch(() => { ok = false; });
        }
      }
      if (!ok) {
        await git(root, ["merge", "--abort"]).catch(() => {});
        blocked.set(t.name, "conflict");
        await emit("autopilot", "warn", `Needs you — ${t.name} conflicts with the main branch`,
          `Autopilot rolled the merge back, so nothing is broken and nothing is lost: ${t.branch} still has all its commits.\n\n` +
          `Conflicting file(s):\n${files.map((f) => `  · ${f}`).join("\n")}\n\n` +
          `Ask a chat pane to "merge the ${t.name} task and resolve the conflicts" when you're ready.`);
        unclaim();
        return;
      }
      await emit("autopilot", "success", `Autopilot resolved a conflict and merged — ${t.name}`,
        `${files.length} file(s) overlapped; the merge was resolved, rebuilt clean and committed.`);
    } else if (!merged) {
      // Every other refusal is a gate doing its job (dirty, live agent, build failed, locked). Those
      // are the user's business only when they persist, and task.mjs already alerts on build failure.
      if (result.reason === "build-failed") blocked.set(t.name, "build");
      unclaim();
      return;
    } else {
      await emit("autopilot", "success", `Autopilot merged ${t.name}`,
        `Built clean and merged into ${result.base || t.base}.` + (cfg.deploy ? " Deploying next." : ""));
    }

    unclaim();

    if (cfg.deploy) {
      // Detached, always: this process is about to be killed by the thing it just started.
      const { spawn } = await import("node:child_process");
      const p = spawn("bash", [path.join(root, "bin", "deploy.sh"), "--detach"], {
        cwd: root, detached: true, stdio: "ignore",
      });
      p.unref();
    }
  } catch (e) {
    await emit("autopilot", "error", "Autopilot hit an error and stopped this pass", String((e as Error)?.message || e));
  } finally {
    ticking = false;
  }
}

/** Called once per server instance from instrumentation.ts. Safe to call twice; the second is a no-op. */
export function startAutopilot(): void {
  if (timer) return;
  void recoverFromCrash();
  const cfg = readConfig();
  timer = setInterval(() => { void tick(); }, cfg.everyMs);
  // Never hold the process open for a timer — a box that won't shut down because of a background
  // poller is a worse bug than a missed merge.
  timer.unref?.();
}

/** Exposed so the API route can report what the runner would see, without duplicating any of it. */
export async function status() {
  const root = await mainRoot();
  const state = root ? await listTasks(root) : null;
  return {
    config: readConfig(),
    inMainCheckout: !!root,
    base: state?.base ?? null,
    tasks: state?.tasks ?? [],
    blocked: Object.fromEntries(blocked),
    claim: readClaim(),
  };
}
