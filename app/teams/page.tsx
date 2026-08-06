"use client";
// Teams — the front door for products and their runs.
//
// Where /agents answers "who is on the roster", this answers "what are they building, and how far
// along is it". Deliberately a thin page: a product tile, its recent runs, and the one button that
// starts a new one. Everything that explains a run lives in the dossier, not in chrome around it.
import { Nav } from "@/components/Nav";
import NewProduct from "@/components/teams/NewProduct";
import NewRun from "@/components/teams/NewRun";
import { StageDots } from "@/components/teams/StageRail";
import { ago } from "@/lib/agents/client";
import { fetchTeams, shortPath, type ProductRow, type TemplateSummary } from "@/lib/teams/client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const RUN_TINT: Record<string, string> = {
  done: "text-green-400", running: "text-amber-300", failed: "text-red-400", stopped: "text-neutral-500",
};

export default function TeamsPage() {
  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [recordsRoot, setRecordsRoot] = useState("");
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState<ProductRow | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchTeams();
      setProducts(d.products);
      setTemplates(d.templates);
      setRecordsRoot(d.recordsRoot);
      setErr(null);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      setProducts([]);
    }
  }, []);

  // Same 4s cadence as the grid and the roster — a stage handing over is the thing you're watching for.
  useEffect(() => { load(); const h = setInterval(load, 4000); return () => clearInterval(h); }, [load]);

  return (
    <div className="bg-bento min-h-screen text-neutral-100">
      <header className="flex items-center gap-3 px-6 py-5">
        <span className="text-xl">⛩</span>
        <h1 className="text-base font-semibold tracking-tight">Teams</h1>
        {products && <span className="text-[11px] text-neutral-600">{products.length}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setCreating(true)} className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-300 hover:border-[var(--sakura)]/50 hover:text-neutral-100">
            + New product
          </button>
          <Nav />
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-6 pb-16">
        {err && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{err}</p>}

        {products && products.length === 0 && (
          <div className="rounded-2xl border border-dashed border-white/15 px-6 py-14 text-center">
            <p className="text-3xl">⛩</p>
            <p className="mt-3 text-sm text-neutral-300">No products yet.</p>
            <p className="mx-auto mt-2 max-w-lg text-[12px] leading-relaxed text-neutral-500">
              A product is a workspace, a team and a record. One task runs through the team a role at a
              time — each in its own session, with its own memory and skills — passing a single document
              along. What comes out is a brief, a design, a test plan, positioning and a signed-off record.
            </p>
            <button onClick={() => setCreating(true)} className="mt-5 rounded-lg bg-[var(--sakura)] px-3.5 py-1.5 text-[12px] font-medium text-white">
              Create your first product
            </button>
          </div>
        )}

        {products?.map((p) => (
          <section key={p.id} className="rounded-2xl border border-white/10 bg-white/[0.03]">
            <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[13px] font-medium text-neutral-100">
                  <Link href={`/teams/${p.id}`} className="hover:text-[var(--sakura)]">{p.name}</Link>
                  {p.running > 0 && (
                    <span className="flex items-center gap-1 rounded bg-[var(--sakura)]/20 px-1.5 text-[9.5px] uppercase tracking-wider text-[var(--sakura)]">
                      <span className="h-1 w-1 animate-pulse rounded-full bg-[var(--sakura)]" />
                      {p.running} running
                    </span>
                  )}
                </p>
                <p className="mt-0.5 truncate text-[10.5px] text-neutral-600">
                  {p.template?.name || p.templateId}
                  {p.workspace && <> · <span className="font-mono">{shortPath(p.workspace)}</span></>}
                  {" · "}<span className="font-mono">{shortPath(p.recordPath)}</span>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {p.template?.roles.map((r) => (
                  <span key={r.key} title={`${r.name} — ${r.role}`} className="text-base">{r.icon}</span>
                ))}
              </div>
              <button onClick={() => setRunning(p)}
                className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-300 hover:border-[var(--sakura)]/50 hover:text-neutral-100">
                New run
              </button>
            </div>

            {p.runs.length === 0 ? (
              <p className="px-4 py-3 text-[11.5px] text-neutral-600">No runs yet.</p>
            ) : (
              <div className="space-y-1 p-2">
                {p.runs.map((r) => (
                  <Link key={r.id} href={`/teams/run/${r.id}`}
                    className="flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-1.5 text-[11.5px] hover:border-white/15">
                    <span className={`w-14 shrink-0 ${RUN_TINT[r.status] || "text-neutral-500"}`}>{r.status}</span>
                    <StageDots stages={r.stages} />
                    <span className="truncate text-neutral-300">{r.title}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-neutral-600">{ago(r.createdAt)}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        ))}
      </main>

      {creating && (
        <NewProduct templates={templates} recordsRoot={recordsRoot}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); window.location.href = `/teams/${id}`; }} />
      )}
      {running && (
        <NewRun product={running} onClose={() => setRunning(null)}
          onStarted={(runId) => { setRunning(null); window.location.href = `/teams/run/${runId}`; }} />
      )}
    </div>
  );
}
