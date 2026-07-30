#!/usr/bin/env node
// The agent CLI — how HQ delegates, and how you drive the roster from a terminal.
//
// A thin wrapper over the dashboard's /api/agents routes and nothing more. That's the design: the
// server already owns spawning, the workspace check and the task records, so a CLI that reimplemented
// any of it would be a second source of truth that drifts. It exists because HQ is a Claude session
// with a Bash tool, and `agent.mjs assign researcher "…"` is something a model gets right first time
// where a hand-written curl with a JSON body is something it gets right most of the time.
//
// Requires the dashboard to be up — it's where agents actually run.
import process from "node:process";

const BASE = process.env.MINAMI_DASHBOARD_URL || "http://127.0.0.1:3000";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const STATUS = { done: c.green("done"), running: c.yellow("running"), queued: c.yellow("queued"), failed: c.red("failed"), stopped: c.dim("stopped") };

async function api(path, init) {
  let r;
  try {
    r = await fetch(`${BASE}${path}`, init);
  } catch {
    die(`can't reach the dashboard at ${BASE} — is it running?`);
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) die(d.error || `${r.status} ${r.statusText}`);
  return d;
}

function die(msg) {
  console.error(c.red("✗ ") + msg);
  process.exit(1);
}

/** `--flag value` pairs, with the rest left as positionals. */
function parse(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else rest.push(argv[i]);
  }
  return { flags, rest };
}

const ago = (ms) => {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

async function cmdList() {
  const { agents } = await api("/api/agents");
  if (!agents.length) return console.log(c.dim("No agents yet. Create one in the dashboard → Agents → New agent."));
  for (const a of agents) {
    const state = a.busy ? c.yellow(`● ${a.label || a.phase}`) : a.live ? c.green("● idle") : c.dim("○ cold");
    console.log(`${a.icon} ${c.b(a.id.padEnd(16))} ${state}`);
    console.log(`   ${a.role || c.dim("(no role set)")}`);
    console.log(`   ${c.dim(`home ${a.home}`)}`);
    if (a.workspaces?.length) console.log(`   ${c.dim(`can work in ${a.workspaces.join(", ")}`)}`);
    if (a.runningTask) console.log(`   ${c.yellow("↻")} ${a.runningTask.title} ${c.dim(`(${a.runningTask.id})`)}`);
    console.log();
  }
}

async function cmdAssign(rest, flags) {
  const [id, ...briefParts] = rest;
  const brief = briefParts.join(" ");
  if (!id || !brief) die(`usage: agent.mjs assign <agent-id> "<brief>" [--cwd <path>] [--handoff <agent-id>] [--title "..."]`);
  const { task } = await api(`/api/agents/${encodeURIComponent(id)}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brief, cwd: flags.cwd, handoffTo: flags.handoff, title: flags.title, from: flags.from }),
  });
  console.log(`${c.green("✓")} assigned to ${c.b(id)} — task ${c.b(task.id)}`);
  console.log(c.dim(`  ${task.title}`));
  console.log(c.dim(`  in ${task.cwd}`));
  if (task.handoffTo) console.log(c.dim(`  hands off to ${task.handoffTo} when done`));
  // Said plainly because the natural next move is to wait for it, and waiting is the one thing that
  // won't work — the run outlives whatever turn issued this command.
  console.log(c.dim(`  runs in the background; check with: agent.mjs task ${task.id}`));
}

async function cmdTasks(rest) {
  const id = rest[0];
  const { tasks } = id
    ? await api(`/api/agents/${encodeURIComponent(id)}/tasks`)
    : await api(`/api/agents`).then(async (d) => ({
        tasks: (await Promise.all(d.agents.map((a) => api(`/api/agents/${a.id}/tasks`).then((x) => x.tasks)))).flat()
          .sort((a, b) => b.createdAt - a.createdAt),
      }));
  if (!tasks.length) return console.log(c.dim("No tasks yet."));
  for (const t of tasks.slice(0, 20)) {
    console.log(`${STATUS[t.status] || t.status} ${c.b(t.id)} ${c.dim(t.agentId)} — ${t.title} ${c.dim(ago(t.createdAt))}`);
  }
}

async function cmdTask(rest) {
  const id = rest[0];
  if (!id) die("usage: agent.mjs task <task-id>");
  const { task } = await api(`/api/agents/tasks/${encodeURIComponent(id)}`);
  console.log(`${STATUS[task.status] || task.status} ${c.b(task.title)}`);
  console.log(c.dim(`  ${task.agentId} · ${task.cwd} · started ${ago(task.startedAt)}${task.endedAt ? ` · ended ${ago(task.endedAt)}` : ""}`));
  if (task.from) console.log(c.dim(`  handed over by ${task.from}`));
  if (task.error) console.log(c.red(`  ${task.error}`));
  if (task.result) console.log(`\n${task.result}\n`);
  else if (task.status === "running") console.log(c.dim("\n  still running — no result yet.\n"));
}

async function cmdStop(rest) {
  const id = rest[0];
  if (!id) die("usage: agent.mjs stop <task-id>");
  const d = await api(`/api/agents/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  console.log(d.ok ? `${c.green("✓")} stopped ${id}` : c.dim(`${id} wasn't running`));
}

function usage() {
  console.log(`${c.b("agent.mjs")} — drive Minami's agents

  list                                    the roster, with live status
  assign <id> "<brief>" [opts]            hand work to an agent (returns immediately)
      --cwd <path>        run in this folder instead of the agent's home
      --handoff <id>      chain another agent onto the result
      --title "..."       short label for the task tile
  tasks [<agent-id>]                      recent runs
  task <task-id>                          one run, with its result
  stop <task-id>                          interrupt a run

Dashboard: ${BASE}  (override with MINAMI_DASHBOARD_URL)`);
}

const { flags, rest } = parse(process.argv.slice(2));
const cmd = rest.shift();
const run = { list: cmdList, assign: cmdAssign, tasks: cmdTasks, task: cmdTask, stop: cmdStop }[cmd];
if (!run) { usage(); process.exit(cmd ? 1 : 0); }
run(rest, flags).catch((e) => die(String(e?.message || e)));
