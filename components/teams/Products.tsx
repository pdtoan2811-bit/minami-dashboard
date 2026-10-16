"use client";
// Products and their runs — the bottom half of /crew (§30), formerly the whole of /teams.
//
// Where the roster answers "who is on the crew", this answers "what are they building, and how far
// along is it". Deliberately thin: a product card, its recent runs, and the one button that starts a
// new one. Everything that explains a run lives in the dossier, not in chrome around it.
import NewProduct from "@/components/teams/NewProduct";
import NewRun from "@/components/teams/NewRun";
import { StageDots } from "@/components/teams/StageRail";
import { Eyebrow, Glass, K } from "@/app/today/ui";
import { ago } from "@/lib/agents/client";
import { matchesProject, useProjectFilter } from "@/lib/project-filter";
import { fetchTeams, shortPath, type ProductRow, type TemplateSummary } from "@/lib/teams/client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const RUN_TINT: Record<string, string> = {
  done: "text-green-400", running: "text-amber-300", failed: "text-red-400", stopped: "text-neutral-500",
};

export default function Products() {
  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [recordsRoot, setRecordsRoot] = useState("");
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState<ProductRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pf] = useProjectFilter();

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

  // A product is named for what it builds, and its workspace is the repo it builds in — either is how
  // the shell's filter would name it. A GTM-only product has no workspace, so the name has to count too.
  const shown = products?.filter((p) => matchesProject(pf, p.name, p.workspace)) || [];
  const hidden = (products?.length || 0) - shown.length;

  return (
    <section id="teams" className="scroll-mt-6 space-y-4">
      <div className="flex items-center gap-2 px-1">
        <Eyebrow>TEAMS{products ? ` · ${products.length}` : ""}</Eyebrow>
        <button onClick={() => setCreating(true)}
          className="ml-auto rounded-full border px-3 py-1 text-[12px] font-medium hover:text-white"
          style={{ borderColor: K.line2, color: K.muted }}>
          + New product
        </button>
      </div>

      {err && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{err}</p>}

      {pf && hidden > 0 && (
        <p className="px-1 text-[11.5px]" style={{ color: K.faint }}>Filtered to {pf} · {hidden} hidden</p>
      )}

      {products && products.length === 0 && (
        <div className="rounded-[30px] border border-dashed px-6 py-14 text-center" style={{ borderColor: K.line2 }}>
          <p className="text-3xl">⛩</p>
          <p className="mt-3 text-sm text-neutral-200">No products yet.</p>
          <p className="mx-auto mt-2 max-w-lg text-[12px] leading-relaxed" style={{ color: K.muted }}>
            A product is a workspace, a team and a record. One task runs through the team a role at a
            time — each in its own session, with its own memory and skills — passing a single document
            along. What comes out is a brief, a design, a test plan, positioning and a signed-off record.
          </p>
          <button onClick={() => setCreating(true)} className="mt-5 rounded-full px-4 py-1.5 text-[12.5px] font-semibold text-white" style={{ background: K.accent }}>
            Create your first product
          </button>
        </div>
      )}

      {shown.map((p) => (
        <Glass key={p.id} className="overflow-hidden">
          <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: K.line }}>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[13px] font-medium text-white">
                <Link href={`/teams/${p.id}`} className="hover:text-[var(--sakura)]">{p.name}</Link>
                {p.running > 0 && (
                  <span className="flex items-center gap-1 rounded bg-[var(--sakura)]/20 px-1.5 text-[9.5px] uppercase tracking-wider text-[var(--sakura)]">
                    <span className="h-1 w-1 animate-pulse rounded-full bg-[var(--sakura)]" />
                    {p.running} running
                  </span>
                )}
              </p>
              <p className="mt-0.5 truncate text-[10.5px]" style={{ color: K.faint }}>
                {p.template?.name || p.templateId}
                {p.workspace && <> · <span className="font-mono">{shortPath(p.workspace)}</span></>}
                {" · "}<span className="font-mono">{shortPath(p.recordPath)}</span>
              </p>
            </div>
            <div className="hidden shrink-0 items-center gap-1 sm:flex">
              {p.template?.roles.map((r) => (
                <span key={r.key} title={`${r.name} — ${r.role}`} className="text-base">{r.icon}</span>
              ))}
            </div>
            <button onClick={() => setRunning(p)}
              className="shrink-0 rounded-full border px-3 py-1 text-[11.5px] hover:text-white"
              style={{ borderColor: K.line2, color: K.muted }}>
              New run
            </button>
          </div>

          {p.runs.length === 0 ? (
            <p className="px-4 py-3 text-[11.5px]" style={{ color: K.faint }}>No runs yet.</p>
          ) : (
            <div className="space-y-1 p-2">
              {p.runs.map((r) => (
                <Link key={r.id} href={`/teams/run/${r.id}`}
                  className="flex items-center gap-2.5 rounded-xl border bg-white/[0.06] px-3 py-1.5 text-[11.5px] hover:bg-white/[0.09]"
                  style={{ borderColor: K.line }}>
                  <span className={`w-14 shrink-0 ${RUN_TINT[r.status] || "text-neutral-500"}`}>{r.status}</span>
                  <StageDots stages={r.stages} />
                  <span className="truncate text-neutral-200">{r.title}</span>
                  <span className="ml-auto shrink-0 tabular-nums" style={{ color: K.faint }}>{ago(r.createdAt)}</span>
                </Link>
              ))}
            </div>
          )}
        </Glass>
      ))}

      {creating && (
        <NewProduct templates={templates} recordsRoot={recordsRoot}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); window.location.href = `/teams/${id}`; }} />
      )}
      {running && (
        <NewRun product={running} onClose={() => setRunning(null)}
          onStarted={(runId) => { setRunning(null); window.location.href = `/teams/run/${runId}`; }} />
      )}
    </section>
  );
}
