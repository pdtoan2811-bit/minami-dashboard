// The chain runner: walk a template's stages in order, one agent task each, all sharing one dossier.
//
// ── Why each stage is an ordinary agent task ──────────────────────────────────────────────────────
// It would be less code to spawn sessions here directly. Going through `assign()` (§14.3) instead
// buys four things that would otherwise all have to be rebuilt, worse: the workspace whitelist is
// enforced, the run is attributed to its agent in the History tab, the mechanical activity log is
// written whatever happens, and the agent gets its wrap-up turn to write back what it learned. A
// stage is just work assigned to an agent — the only thing the team layer adds is *order* and a
// shared document.
//
// ── Why it polls the task record ─────────────────────────────────────────────────────────────────
// Same reason the agent runner polls the manager rather than subscribing: a subscriber counts as a
// connected client and would suppress the manager's rescue of a session parked on a prompt nobody can
// answer. Here it's one level further out — this watches the TASK RECORD, which `drive()` owns, so a
// stage is only "done" once its wrap-up has run and its memory is current. The next stage therefore
// starts against an agent that has already learned from the previous one.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { getAgent } from "../agents/store";
import { assign, stopTask } from "../agents/runner";
import { getTask } from "../agents/tasks";
import { commitBrain } from "./brains";
import { appendSystemNote, hasSection, initDossier, readDossier, runDir } from "./dossier";
import { getRun, listRuns, patchRun, patchStage, reapOrphanRuns, writeRun } from "./runs";
import { getTemplate, roleOf, templateProblems } from "./templates";
import type { Product, RunStage, TeamRun, TeamTemplate } from "./types";

const POLL_MS = 3_000;

// A whole run's ceiling, across every stage. Each stage already has the agent runner's own 30-minute
// limit; this is the backstop for a chain that keeps individually-legal stages going forever.
const MAX_RUN_MS = Math.max(
  5 * 60_000,
  Number(process.env.MINAMI_TEAM_RUN_TIMEOUT_MS) || 3 * 60 * 60 * 1000,
);

// Refused, not truncated. A chain longer than this is a template mistake, and silently running the
// first twelve stages of a fifteen-stage template would produce a run that looks complete and isn't.
const MAX_STAGES = 12;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The brief one stage runs as, wrapped around the template's instruction.
 *
 * Everything positional is spelled out — the absolute dossier path, the exact heading, who ran before
 * and who runs next. The agent receiving this has never seen this run: it has its own memory, its own
 * folder, and no access to the conversation that started any of it. Anything implied is lost.
 */
function stageBrief(o: {
  run: TeamRun;
  product: Product;
  template: TeamTemplate;
  stage: RunStage;
  index: number;
  instruction: string;
}): string {
  const { run, product, template, stage, index } = o;
  const prev = template.chain[index - 1];
  const next = template.chain[index + 1];
  const last = index === template.chain.length - 1;
  const prevRole = prev ? roleOf(template, prev.role)?.name || prev.role : null;
  const nextRole = next ? roleOf(template, next.role)?.name || next.role : null;

  return `You are the **${roleOf(template, stage.role)?.name || stage.role}** stage of a team run on **${product.name}**.

${o.instruction}

---

## The dossier

\`${runDir(run.id)}/dossier.md\`

**Read it in full first** — it opens with the request and carries every earlier stage's section. Then
append **one** section, under exactly this heading:

\`\`\`
## ${stage.section}
\`\`\`

${prevRole ? `**${prevRole}** wrote the section before yours.` : "You are the first stage — the dossier holds only the request."} ${
    nextRole ? `**${nextRole}** picks it up after you, so end with \`### Handoff → ${nextRole}\`.` : "You are the last stage — end with `### Handoff → close`."
  }

Follow your \`dossier\` skill: append only, never edit or reword another role's section, never rewrite
the file.

## Where things are

- **Product record:** \`${product.recordPath}\` — the durable, curated history of this product.${last ? "" : " Read from it if you need background; don't write to it, the closing stage owns that."}
- **Workspace:** ${product.workspace ? `\`${product.workspace}\`` : "this product has no repo"}
${last ? `\n## Closing the run\n\nYou are last. After your section, file the record at \`${product.recordPath}\` — merge into what's already there and update \`00-index.md\` last.${product.sync ? "\n\nThis product is set to sync: after filing, run `bash ~/secondBrain/bin/sync.sh \"<product>: <run title>\"` so the record reaches every device." : "\n\n**Do not sync, push, publish or send anything.** Write the files and stop — this run is unattended, and pushing a record nobody has read yet is not yours to do."}` : ""}`;
}

/** Wait for one stage's agent task to reach a terminal state. */
async function awaitTask(taskId: string, deadline: number): Promise<"done" | "failed" | "stopped" | "timeout"> {
  for (;;) {
    await sleep(POLL_MS);
    const t = getTask(taskId);
    if (!t) return "failed"; // the record can't vanish under us; if it did, nothing is watching this run
    if (t.status === "done") return "done";
    if (t.status === "failed") return "failed";
    if (t.status === "stopped") return "stopped";
    if (Date.now() > deadline) {
      await stopTask(taskId).catch(() => {});
      return "timeout";
    }
  }
}

/**
 * Walk the chain. Never throws at its caller — `startRun` returns as soon as the run is dispatched, so
 * anything that goes wrong here has to land on the run record where it can be read.
 */
async function drive(run: TeamRun, product: Product, template: TeamTemplate): Promise<void> {
  const deadline = Date.now() + MAX_RUN_MS;

  const fail = (error: string) => {
    appendSystemNote(run.id, `Run ended: ${error}`);
    patchRun(run.id, { status: "failed", error, endedAt: Date.now() });
  };

  try {
    for (let i = 0; i < template.chain.length; i++) {
      const spec = template.chain[i];
      const stage = run.stages[i];

      // Re-read every iteration: Stop is on screen for the whole run, and the only thing that knows a
      // human ended it is the record. Same reasoning as the agent runner's post-turn stop check —
      // there, missing it reported a stopped run as a success.
      if (getRun(run.id)?.status !== "running") return;

      const agent = getAgent(stage.agentId);
      if (!agent) {
        patchStage(run.id, stage.key, { status: "failed", endedAt: Date.now(), error: "agent no longer exists" });
        fail(`the ${spec.role} agent (\`${stage.agentId}\`) no longer exists — recreate it, or recreate the product.`);
        return;
      }

      const roleSpec = roleOf(template, spec.role);
      const cwd = roleSpec?.needsWorkspace && product.workspace ? product.workspace : agent.home;

      let taskId: string;
      try {
        const task = assign(agent, {
          // Prefixed with the product and the section so the bento board and the agent's own history
          // show something meaningful — a board full of "Untitled task" is a board nobody reads.
          title: `${product.name}: ${spec.section}`,
          brief: stageBrief({ run, product, template, stage, index: i, instruction: spec.instruction }),
          cwd,
        });
        taskId = task.id;
      } catch (e) {
        // Almost always the workspace whitelist (§14.3) — a role that needs the repo but wasn't
        // granted it. Named plainly, because "assign failed" sends you reading the wrong code.
        const msg = String((e as Error)?.message || e);
        patchStage(run.id, stage.key, { status: "failed", endedAt: Date.now(), error: msg });
        fail(`could not start the ${spec.role} stage — ${msg}`);
        return;
      }

      patchStage(run.id, stage.key, { status: "running", taskId, startedAt: Date.now() });
      const why = await awaitTask(taskId, deadline);

      if (getRun(run.id)?.status !== "running") return; // stopped while that stage ran

      if (why !== "done") {
        const t = getTask(taskId);
        const error = {
          failed: t?.error || "the stage failed",
          stopped: "the stage was stopped",
          timeout: `the run passed its ${Math.round(MAX_RUN_MS / 60000)}-minute ceiling`,
        }[why];
        patchStage(run.id, stage.key, { status: why === "timeout" ? "failed" : why, endedAt: Date.now(), error });
        fail(`${spec.role} — ${error}`);
        return;
      }

      // Did the section actually land? A stage can succeed and write nothing, and every later stage
      // then reads a document with a hole in it and no indication there was ever meant to be more.
      const appended = hasSection(readDossier(run.id), stage.section);
      patchStage(run.id, stage.key, { status: "done", endedAt: Date.now(), appended });
      if (!appended) {
        appendSystemNote(
          run.id,
          `${spec.role} finished without writing "${stage.section}". The stage below is missing that context.`,
        );
      }

      // After the task is done — which is after its wrap-up turn — so this captures the agent's own
      // memory edits as well as any change it made to its persona or skills.
      commitBrain(agent.home, `run ${run.id}: ${spec.key} (${product.name})`);
    }

    patchRun(run.id, { status: "done", endedAt: Date.now() });
  } catch (e) {
    fail(String((e as Error)?.message || e));
  }
}

export type StartRunInput = { title?: string; brief: string };

/**
 * Start a run. Returns the moment it's dispatched — a run is minutes to tens of minutes, and the
 * caller (a fetch, or HQ from inside its own turn) must not hang on it.
 *
 * Everything checkable is checked HERE rather than in `drive()`: a missing agent or a broken template
 * found three stages in has already cost you twenty minutes and half a dossier.
 */
export function startRun(product: Product, input: StartRunInput): TeamRun {
  const template = getTemplate(product.templateId);
  if (!template) throw new Error(`this product's template (${product.templateId}) no longer exists`);
  const problems = templateProblems(template);
  if (problems.length) throw new Error(`template "${template.id}" is broken: ${problems.join("; ")}`);
  if (template.chain.length > MAX_STAGES) {
    throw new Error(`template "${template.id}" has ${template.chain.length} stages; the ceiling is ${MAX_STAGES}`);
  }

  const brief = input.brief.trim();
  if (!brief) throw new Error("a run needs a brief");

  const stages: RunStage[] = template.chain.map((s) => {
    const agentId = product.roles[s.role];
    if (!agentId) throw new Error(`this product has no agent for the "${s.role}" role`);
    if (!getAgent(agentId)) {
      throw new Error(`the "${s.role}" agent (\`${agentId}\`) no longer exists — recreate it before running`);
    }
    return { key: s.key, role: s.role, section: s.section, agentId, status: "pending" as const };
  });

  let id = randomUUID().slice(0, 8);
  for (let n = 0; fs.existsSync(runDir(id)); n++) id = randomUUID().slice(0, 8);

  const run: TeamRun = {
    id,
    productId: product.id,
    productName: product.name,
    templateId: template.id,
    title: (input.title || brief).trim().split("\n")[0].slice(0, 80) || "Untitled run",
    brief,
    stages,
    status: "running",
    createdAt: Date.now(),
    // The process whose `drive()` is about to start polling. Anything else finding this run `running`
    // is looking at work that died with its server — see reapOrphanRuns().
    pid: process.pid,
  };

  writeRun(run);
  initDossier(run, product, template);
  void drive(run, product, template);
  return run;
}

/**
 * Stop a run in flight. The run record is closed here rather than by `drive()`, which is watching it —
 * `drive()` checks the record after every stage precisely so this is the thing that decides.
 */
export async function stopRun(runId: string): Promise<boolean> {
  const run = getRun(runId);
  if (!run || run.status !== "running") return false;
  patchRun(runId, { status: "stopped", endedAt: Date.now() });
  const live = run.stages.find((s) => s.status === "running");
  if (live?.taskId) await stopTask(live.taskId).catch(() => {});
  if (live) patchStage(runId, live.key, { status: "stopped", endedAt: Date.now() });
  appendSystemNote(runId, "Stopped by you.");
  return true;
}

export { listRuns };

// Import-time, for the same reason the agent runner reaps orphaned tasks: every route that can show a
// run imports this, so the Teams view is honest from the first paint after a restart.
reapOrphanRuns();
