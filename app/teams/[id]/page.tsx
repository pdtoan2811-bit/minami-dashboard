"use client";
// One product: its team, its runs, and the two settings that are genuinely settings.
//
// The team list links out to /agents rather than reimplementing an agent view here. A role IS an
// agent — the same brain, shared with every other product using that role — and giving it a second
// home in this page would invite editing it in a place that doesn't know that.
import { Nav } from "@/components/Nav";
import NewRun from "@/components/teams/NewRun";
import { StageDots } from "@/components/teams/StageRail";
import { ago } from "@/lib/agents/client";
import {
  fetchProduct, patchProduct, removeProduct, shortPath,
  type AgentDef, type Product, type TeamRun, type TemplateSummary,
} from "@/lib/teams/client";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";

const RUN_TINT: Record<string, string> = {
  done: "text-green-400", running: "text-amber-300", failed: "text-red-400", stopped: "text-neutral-500",
};

export default function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [product, setProduct] = useState<Product | null>(null);
  const [template, setTemplate] = useState<TemplateSummary | null>(null);
  const [team, setTeam] = useState<{ role: string; agentId: string; agent: AgentDef | null }[]>([]);
  const [runs, setRuns] = useState<TeamRun[]>([]);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchProduct(id);
      setProduct(d.product); setTemplate(d.template); setTeam(d.team); setRuns(d.runs);
      setErr(null);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
  }, [id]);

  useEffect(() => { load(); const h = setInterval(load, 4000); return () => clearInterval(h); }, [load]);

  return (
    <div className="bg-bento min-h-screen text-neutral-100">
      <header className="flex items-center gap-3 px-6 py-5">
        <Link href="/teams" className="text-neutral-600 hover:text-neutral-300">←</Link>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold tracking-tight">{product?.name || "Product"}</h1>
          <p className="truncate text-[10.5px] text-neutral-600">
            {template?.name || product?.templateId}
            {product?.workspace && <> · <span className="font-mono">{shortPath(product.workspace)}</span></>}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {product && (
            <button onClick={() => setStarting(true)} className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-300 hover:border-[var(--sakura)]/50 hover:text-neutral-100">
              New run
            </button>
          )}
          <Nav />
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-6 pb-16">
        {err && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{err}</p>}

        {product && (
          <>
            <section>
              <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">The chain</h2>
              <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
                {template?.chain.map((s, i) => {
                  const r = template.roles.find((x) => x.key === s.role);
                  return (
                    <span key={s.key} className="flex items-center gap-1.5 text-[11.5px] text-neutral-400">
                      {i > 0 && <span className="text-neutral-700">→</span>}
                      <span>{r?.icon}</span>{r?.name || s.role}
                    </span>
                  );
                })}
              </div>
            </section>

            <section>
              <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">Team</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-2">
                {team.map((t) => {
                  const spec = template?.roles.find((r) => r.key === t.role);
                  return (
                    <Link key={t.role} href={`/agents/${t.agentId}`}
                      className="flex items-start gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 hover:border-white/20">
                      <span className="text-lg leading-none">{spec?.icon || t.agent?.icon}</span>
                      <span className="min-w-0">
                        <span className="block text-[12.5px] text-neutral-100">
                          {t.agent?.name || t.agentId}
                          {!t.agent && <span className="ml-1.5 text-[10px] text-red-400">missing</span>}
                        </span>
                        <span className="mt-0.5 block text-[10.5px] leading-relaxed text-neutral-600">{spec?.role}</span>
                        <span className="mt-1 block font-mono text-[10px] text-neutral-700">{t.agent ? shortPath(t.agent.home) : ""}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
              <p className="mt-1.5 px-1 text-[10.5px] leading-relaxed text-neutral-600">
                These brains are shared: the same {template?.roles[0]?.name || "role"} works on every product using this
                template, so craft compounds. What&apos;s specific to <b>{product.name}</b> lives in its record, not in
                their memory.
              </p>
            </section>

            <section>
              <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">Record</h2>
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
                <p className="font-mono text-[11.5px] text-neutral-300">{shortPath(product.recordPath)}</p>
                <p className="mt-1 text-[10.5px] leading-relaxed text-neutral-600">
                  Curated by the closing role after every run. Read <code>00-index.md</code> there before assuming
                  anything about this product&apos;s history.
                </p>
                <button
                  onClick={async () => { await patchProduct(product.id, { sync: !product.sync }).catch(() => {}); load(); }}
                  className={`mt-2.5 rounded-lg border px-2.5 py-1 text-[11px] ${
                    product.sync ? "border-[var(--sakura)]/40 text-[var(--sakura)]" : "border-white/10 text-neutral-400 hover:text-neutral-100"
                  }`}>
                  {product.sync ? "Syncing the record after each run" : "Sync off — the record stays local"}
                </button>
              </div>
            </section>

            <section>
              <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">Runs</h2>
              {runs.length === 0 ? (
                <p className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-[11.5px] text-neutral-600">
                  No runs yet.
                </p>
              ) : (
                <div className="space-y-1">
                  {runs.map((r) => (
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

            <section>
              <button
                onClick={async () => {
                  const d = await removeProduct(product.id).catch(() => null);
                  if (d) window.location.href = "/teams";
                }}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-neutral-500 hover:border-red-400/40 hover:text-red-300">
                Delete product
              </button>
              <p className="mt-1.5 text-[10.5px] leading-relaxed text-neutral-600">
                Removes the registry row and the block in the repo&apos;s CLAUDE.md. The record folder and the
                role brains stay — the record is this product&apos;s accumulated understanding, and the brains
                belong to every other product too.
              </p>
            </section>
          </>
        )}
      </main>

      {starting && product && (
        <NewRun product={{ id: product.id, name: product.name, template }}
          onClose={() => setStarting(false)}
          onStarted={(runId) => { setStarting(false); window.location.href = `/teams/run/${runId}`; }} />
      )}
    </div>
  );
}
