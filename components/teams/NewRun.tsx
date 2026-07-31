"use client";
// Starting a run.
//
// One field, deliberately. Everything else a run needs — who does what, in what order, where the
// output goes — is already decided by the product and its template, and re-asking it here would be a
// form standing between you and the thing you actually want to say.
import { startRun, type ProductRow } from "@/lib/teams/client";
import { useState } from "react";

export default function NewRun({
  product, onClose, onStarted,
}: {
  product: Pick<ProductRow, "id" | "name" | "template">;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const d = await startRun(product.id, brief);
      onStarted(d.run.id);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-[#141416] p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-medium">New run · {product.name}</h2>
        <p className="mt-1 text-[11.5px] leading-relaxed text-neutral-500">
          Say what you want done. The first role turns it into a brief; nobody downstream can ask you a
          question, so anything you leave out gets decided by an assumption you&apos;ll read about later.
        </p>

        <textarea autoFocus value={brief} onChange={(e) => setBrief(e.target.value)} rows={7}
          placeholder="Add a saved-views feature to the bento board — people keep re-applying the same filters every morning."
          className="mt-3 w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-[var(--sakura)]/50" />

        {product.template && (
          <div className="mt-3 flex flex-wrap items-center gap-1 text-[11px] text-neutral-500">
            {product.template.chain.map((s, i) => {
              const r = product.template!.roles.find((x) => x.key === s.role);
              return (
                <span key={s.key} className="flex items-center gap-1">
                  {i > 0 && <span className="text-neutral-700">→</span>}
                  <span>{r?.icon}</span>{r?.name || s.role}
                </span>
              );
            })}
            <span className="ml-auto text-neutral-600">{product.template.chain.length} stages · unattended</span>
          </div>
        )}

        {err && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-[11.5px] text-red-300">{err}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-[12px] text-neutral-400 hover:text-neutral-100">Cancel</button>
          <button onClick={submit} disabled={!brief.trim() || busy}
            className="rounded-lg bg-[var(--sakura)] px-3.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-40">
            {busy ? "Starting…" : "Start run"}
          </button>
        </div>
      </div>
    </div>
  );
}
