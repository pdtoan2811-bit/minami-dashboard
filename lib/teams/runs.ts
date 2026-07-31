// Run records: one folder per run, holding the run's state and its dossier.
//
// A folder rather than a row in a shared file, because the dossier has to live somewhere anyway and
// keeping the two together means a run is one self-contained thing you can read, copy, or delete with
// no index to keep in step. It also makes the write pattern safe by construction: exactly one runner
// writes any given run.json, so concurrent runs never contend.
//
// Listing is deliberately bounded. The Teams view polls, and reading every run.json on every poll
// would grow without limit — so the listing stats the directories (cheap), takes the newest N, and
// only parses those.
import fs from "node:fs";
import path from "node:path";
import { runDir, RUNS_DIR } from "./dossier";
import type { RunStage, TeamRun, TeamRunStatus } from "./types";

const LIST_LIMIT = 40;

function fileFor(runId: string): string {
  return path.join(runDir(runId), "run.json");
}

export function getRun(runId: string): TeamRun | null {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(runId), "utf8")) as TeamRun;
    return raw && Array.isArray(raw.stages) ? raw : null;
  } catch { return null; }
}

export function writeRun(run: TeamRun): TeamRun {
  const dir = runDir(run.id);
  fs.mkdirSync(dir, { recursive: true });
  // tmp + rename: the runner rewrites this mid-run while the Teams view is polling it, and a torn read
  // there would blank a running run out of the list.
  const tmp = path.join(dir, `run.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2) + "\n");
  fs.renameSync(tmp, fileFor(run.id));
  return run;
}

export function patchRun(runId: string, patch: Partial<TeamRun>): TeamRun | null {
  const cur = getRun(runId);
  if (!cur) return null;
  return writeRun({ ...cur, ...patch, id: cur.id });
}

export function patchStage(runId: string, stageKey: string, patch: Partial<RunStage>): TeamRun | null {
  const cur = getRun(runId);
  if (!cur) return null;
  const stages = cur.stages.map((s) => (s.key === stageKey ? { ...s, ...patch, key: s.key } : s));
  return writeRun({ ...cur, stages });
}

/** Newest first. `productId` filters to one product's runs. */
export function listRuns(productId?: string, limit = LIST_LIMIT): TeamRun[] {
  let names: string[];
  try { names = fs.readdirSync(RUNS_DIR); } catch { return []; }
  const stamped: { id: string; at: number }[] = [];
  for (const n of names) {
    try {
      const st = fs.statSync(path.join(RUNS_DIR, n));
      if (st.isDirectory()) stamped.push({ id: n, at: st.mtimeMs });
    } catch { /* vanished between readdir and stat */ }
  }
  stamped.sort((a, b) => b.at - a.at);
  const out: TeamRun[] = [];
  for (const s of stamped) {
    if (out.length >= limit) break;
    const r = getRun(s.id);
    if (!r) continue;
    if (productId && r.productId !== productId) continue;
    out.push(r);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function isTerminal(status: TeamRunStatus): boolean {
  return status !== "running";
}

/**
 * Close out runs a DIFFERENT process left mid-flight.
 *
 * Same lie as an orphaned agent task (§14.3): every stage is a live session, live sessions are
 * children of the server that started them, and a deploy restarts it. A run still marked `running`
 * from a dead process has no driver watching it and never will — showing it as in-flight means the
 * Teams view is permanently wrong in the one place it's most tempting to trust.
 *
 * Keyed on the pid rather than on "we are at module load", for the reason recorded on the task-file
 * version of this: module load happens more than once per process, and reaping a run whose driver is
 * still polling kills a live chain.
 */
export function reapOrphanRuns(): number {
  let n = 0;
  for (const run of listRuns(undefined, 200)) {
    if (run.status !== "running" || run.pid === process.pid) continue;
    n++;
    writeRun({
      ...run,
      status: "failed",
      endedAt: Date.now(),
      error: "The dashboard restarted while this run was in flight — live sessions don't survive a restart.",
      stages: run.stages.map((s) =>
        s.status === "running" || s.status === "pending"
          ? { ...s, status: s.status === "running" ? ("failed" as const) : ("pending" as const), endedAt: s.status === "running" ? Date.now() : undefined }
          : s,
      ),
    });
  }
  return n;
}
