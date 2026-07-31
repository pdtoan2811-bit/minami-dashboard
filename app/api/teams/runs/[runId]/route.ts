import { dossierPath, readDossier } from "@/lib/teams/dossier";
import { stopRun } from "@/lib/teams/run";
import { getRun } from "@/lib/teams/runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * One run, with its dossier.
 *
 * The dossier is sent whole rather than diffed. It's a markdown file that tops out in the low tens of
 * kilobytes, the page polls it every few seconds while a run is live, and a diff protocol here would
 * be a second source of truth about a file whose entire virtue is that it's just a file on disk.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = getRun(runId);
  if (!run) return Response.json({ error: "no such run" }, { status: 404 });
  return Response.json({ run, dossier: readDossier(runId), dossierPath: dossierPath(runId) });
}

/** Stop a run in flight. Its current stage is interrupted; the sections already written stay. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const ok = await stopRun(runId);
  return Response.json({ ok, run: getRun(runId) });
}
