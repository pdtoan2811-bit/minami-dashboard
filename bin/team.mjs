#!/usr/bin/env node
// The team CLI — start a run and follow it from a terminal, or from inside another Claude session.
//
// Same design as bin/agent.mjs and for the same reason: a thin wrapper over /api/teams, with no logic
// of its own. The server owns the chain, the workspace checks and the run records; a CLI that
// duplicated any of that would be a second source of truth that drifts.
//
// This is the command the team block in a workspace's CLAUDE.md names, so it's usually reached by a
// Claude session working in that repo rather than by a human at a prompt.
import process from "node:process";

const BASE = process.env.MINAMI_DASHBOARD_URL || "http://127.0.0.1:3000";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const STATUS = {
  done: c.green("done"), running: c.yellow("running"), pending: c.dim("pending"),
  queued: c.dim("queued"), failed: c.red("failed"), stopped: c.dim("stopped"),
};

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
  const { products, templates } = await api("/api/teams");
  if (!products.length) {
    console.log(c.dim("No products yet. Create one in the dashboard → Teams → New product."));
    console.log(c.dim(`Templates available: ${templates.map((t) => t.id).join(", ")}`));
    return;
  }
  for (const p of products) {
    console.log(`${c.b(p.id.padEnd(20))} ${p.name} ${p.running ? c.yellow(`● ${p.running} running`) : ""}`);
    console.log(`   ${c.dim(`${p.template?.name || p.templateId} · ${p.template?.chain.map((s) => s.role).join(" → ") || ""}`)}`);
    if (p.workspace) console.log(`   ${c.dim(`workspace ${p.workspace}`)}`);
    console.log(`   ${c.dim(`record ${p.recordPath}`)}`);
    console.log();
  }
}

async function cmdRun(rest, flags) {
  const [id, ...briefParts] = rest;
  const brief = briefParts.join(" ");
  if (!id || !brief) die(`usage: team.mjs run <product-id> "<what you want done>" [--title "..."]`);
  const { run } = await api("/api/teams/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: id, brief, title: flags.title }),
  });
  console.log(`${c.green("✓")} run ${c.b(run.id)} started on ${c.b(run.productName)}`);
  console.log(c.dim(`  ${run.title}`));
  console.log(c.dim(`  ${run.stages.length} stages: ${run.stages.map((s) => s.role).join(" → ")}`));
  // Said plainly because the natural next move is to wait, and waiting is the one thing that won't
  // work: the run outlives whatever turn issued this command, by design.
  console.log(c.dim(`  runs in the background — minutes to tens of minutes.`));
  console.log(c.dim(`  follow it: team.mjs run-status ${run.id}`));
}

async function cmdRuns(rest) {
  const q = rest[0] ? `?product=${encodeURIComponent(rest[0])}` : "";
  const { runs } = await api(`/api/teams/runs${q}`);
  if (!runs.length) return console.log(c.dim("No runs yet."));
  for (const r of runs.slice(0, 20)) {
    const at = r.stages.filter((s) => s.status === "done").length;
    console.log(`${STATUS[r.status] || r.status} ${c.b(r.id)} ${c.dim(`${at}/${r.stages.length}`)} ${r.productName} — ${r.title} ${c.dim(ago(r.createdAt))}`);
  }
}

async function cmdRunStatus(rest, flags) {
  const id = rest[0];
  if (!id) die("usage: team.mjs run-status <run-id> [--dossier]");
  const { run, dossier, dossierPath } = await api(`/api/teams/runs/${encodeURIComponent(id)}`);
  console.log(`${STATUS[run.status] || run.status} ${c.b(run.title)}`);
  console.log(c.dim(`  ${run.productName} · ${run.templateId} · started ${ago(run.createdAt)}`));
  console.log(c.dim(`  dossier ${dossierPath}`));
  if (run.error) console.log(c.red(`  ${run.error}`));
  console.log();
  for (const s of run.stages) {
    // The "no section" flag is surfaced here and not only in the UI: a stage that finished without
    // writing is the failure most likely to be mistaken for a success by whoever reads this next.
    const hole = s.status === "done" && s.appended === false ? c.yellow("  ⚠ wrote no section") : "";
    console.log(`  ${STATUS[s.status] || s.status} ${s.section}${hole}${s.error ? c.red(`  ${s.error}`) : ""}`);
  }
  // `in`, not a truthiness check: parse() gives a trailing `--dossier` the value `undefined`, so
  // `flags.dossier` alone silently never prints — the flag would look broken rather than absent.
  if ("dossier" in flags) console.log(`\n${dossier}`);
}

async function cmdStop(rest) {
  const id = rest[0];
  if (!id) die("usage: team.mjs stop <run-id>");
  const d = await api(`/api/teams/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
  console.log(d.ok ? `${c.green("✓")} stopped ${id}` : c.dim(`${id} wasn't running`));
}

function usage() {
  console.log(`${c.b("team.mjs")} — run a task through a team

  list                                    products, their team and their record
  run <product-id> "<task>" [--title …]   start a run (returns immediately)
  runs [<product-id>]                     recent runs
  run-status <run-id> [--dossier]         stages, and optionally the whole dossier
  stop <run-id>                           interrupt a run

A run is one stage per role, each an unattended session in that role's own folder, all appending to
one dossier. It takes minutes to tens of minutes and nobody can answer a question mid-run.

Dashboard: ${BASE}  (override with MINAMI_DASHBOARD_URL)`);
}

const { flags, rest } = parse(process.argv.slice(2));
const cmd = rest.shift();
const run = { list: cmdList, run: cmdRun, runs: cmdRuns, "run-status": cmdRunStatus, stop: cmdStop }[cmd];
if (!run) { usage(); process.exit(cmd ? 1 : 0); }
run(rest, flags).catch((e) => die(String(e?.message || e)));
