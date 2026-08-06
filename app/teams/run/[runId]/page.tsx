"use client";
// One run: the stage rail, and the dossier as it fills in.
//
// The dossier is the page. Everything else here is navigation around it — because the dossier is what
// a run actually produces, and a UI that summarised it would be a second, worse account of a document
// that is already meant to be read.
import Markdown from "@/components/Markdown";
import { Nav } from "@/components/Nav";
import StageRail from "@/components/teams/StageRail";
import { ago } from "@/lib/agents/client";
import { fetchRun, shortPath, stopRun, type TeamRun } from "@/lib/teams/client";
import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";

export default function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const [run, setRun] = useState<TeamRun | null>(null);
  const [dossier, setDossier] = useState("");
  const [path, setPath] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await fetchRun(runId);
      setRun(d.run);
      setDossier(d.dossier);
      setPath(d.dossierPath);
      live.current = d.run.status === "running";
      setErr(null);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      live.current = false;
    }
  }, [runId]);

  // Polls only while the run is live. A finished run is a static file: continuing to re-fetch it would
  // burn a request every 4s on every tab anyone left open on a run from last week.
  useEffect(() => {
    load();
    const h = setInterval(() => { if (live.current) load(); }, 4000);
    return () => clearInterval(h);
  }, [load]);

  return (
    <div className="bg-bento min-h-screen text-neutral-100">
      <header className="flex items-center gap-3 px-6 py-5">
        <Link href="/teams" className="text-neutral-600 hover:text-neutral-300">←</Link>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold tracking-tight">{run?.title || "Run"}</h1>
          {run && (
            <p className="truncate text-[10.5px] text-neutral-600">
              <Link href={`/teams/${run.productId}`} className="hover:text-neutral-400">{run.productName}</Link>
              {" · "}{run.templateId} · {ago(run.createdAt)} ago · <span className="font-mono">{shortPath(path)}</span>
            </p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {run?.status === "running" && (
            <button onClick={async () => { setStopping(true); await stopRun(runId).catch(() => {}); load(); setStopping(false); }}
              disabled={stopping}
              className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-300 hover:border-red-400/50 hover:text-red-300 disabled:opacity-40">
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
          <Nav />
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-4 px-6 pb-16">
        {err && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{err}</p>}

        {run && (
          <>
            <section>
              <div className="mb-2 flex items-center gap-2 px-1">
                <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">Stages</h2>
                <span className={`text-[11px] ${run.status === "failed" ? "text-red-400" : run.status === "running" ? "text-amber-300" : "text-neutral-500"}`}>
                  {run.status}
                </span>
              </div>
              <StageRail stages={run.stages} />
              {run.error && <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-[11.5px] text-red-300">{run.error}</p>}
            </section>

            <section>
              <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">Dossier</h2>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4 text-[13px]">
                {dossier ? <Markdown text={dossier} /> : <p className="text-[11.5px] text-neutral-600">Nothing written yet.</p>}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
