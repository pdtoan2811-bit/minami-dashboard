"use client";
// Creating a product: pick a template, name it, point it at a repo.
//
// The dialog's job is to make the two consequences visible BEFORE you commit, because both of them
// touch things outside this app: role brains get created on disk (shared with every other product),
// and a block gets written into your repo's CLAUDE.md. Discovering either afterwards in `git status`
// is how a tool loses trust it didn't need to lose.
import FolderPicker from "@/components/FolderPicker";
import { createProduct, shortPath, type TemplateSummary } from "@/lib/teams/client";
import { useState } from "react";

export default function NewProduct({
  templates, recordsRoot, onClose, onCreated,
}: {
  templates: TemplateSummary[];
  recordsRoot: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState(templates[0]?.id || "");
  const [workspace, setWorkspace] = useState("");
  const [record, setRecord] = useState("");
  const [sync, setSync] = useState(false);
  const [repoHook, setRepoHook] = useState(true);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const template = templates.find((t) => t.id === templateId) || null;
  const recordPath = record || (name ? `${recordsRoot}/${name}` : "");

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const d = await createProduct({ name, templateId, workspace: workspace || undefined, recordPath: record || undefined, sync, repoHook });
      onCreated(d.product.id);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/10 bg-[#141416] p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-medium">New product</h2>
        <p className="mt-1 text-[11.5px] leading-relaxed text-neutral-500">
          A product is a workspace, a team, and a record. Tasks you give it run through the team one role
          at a time, each in its own session, passing one document along.
        </p>

        <label className="mt-4 block text-[11px] uppercase tracking-wider text-neutral-500">Name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ecom Intel"
          className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] outline-none focus:border-[var(--sakura)]/50" />

        <label className="mt-4 block text-[11px] uppercase tracking-wider text-neutral-500">Team</label>
        <div className="mt-1 space-y-1.5">
          {templates.map((t) => (
            <button key={t.id} onClick={() => setTemplateId(t.id)}
              className={`block w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                t.id === templateId ? "border-[var(--sakura)]/50 bg-[var(--sakura)]/[0.07]" : "border-white/10 bg-white/[0.02] hover:border-white/20"
              }`}>
              <p className="text-[12.5px] font-medium text-neutral-100">{t.name}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">{t.description}</p>
            </button>
          ))}
        </div>

        {/* The chain, spelled out. "Five roles" says nothing; the order is the thing that decides what
            the run produces, and the PM appearing twice is the part worth seeing before you commit. */}
        {template && (
          <div className="mt-3 flex flex-wrap items-center gap-1 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
            {template.chain.map((s, i) => {
              const r = template.roles.find((x) => x.key === s.role);
              return (
                <span key={s.key} className="flex items-center gap-1 text-[11px] text-neutral-400">
                  {i > 0 && <span className="text-neutral-700">→</span>}
                  <span>{r?.icon}</span>{r?.name || s.role}
                </span>
              );
            })}
          </div>
        )}

        <label className="mt-4 block text-[11px] uppercase tracking-wider text-neutral-500">
          Workspace <span className="normal-case tracking-normal text-neutral-600">— optional; the repo the work happens in</span>
        </label>
        <div className="mt-1 flex gap-2">
          <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="~/ecomIntel"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-[12px] outline-none focus:border-[var(--sakura)]/50" />
          <button onClick={() => setPicking(true)} className="shrink-0 rounded-lg border border-white/10 px-2.5 text-[11px] text-neutral-400 hover:text-neutral-100">Browse</button>
        </div>
        {template && workspace && (
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-neutral-600">
            Granted to {template.roles.filter((r) => r.needsWorkspace).map((r) => r.name).join(", ") || "no role"} only.
            The rest work from the dossier — a whitelist everyone is on describes nothing.
          </p>
        )}

        <label className="mt-4 block text-[11px] uppercase tracking-wider text-neutral-500">Record</label>
        <input value={record} onChange={(e) => setRecord(e.target.value)} placeholder={recordPath || `${recordsRoot}/<name>`}
          className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-[12px] outline-none focus:border-[var(--sakura)]/50" />
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-neutral-600">
          The durable, curated half. The closing role files each run here and keeps <code>00-index.md</code> true.
        </p>

        <div className="mt-4 space-y-2">
          {workspace && (
            <Check on={repoHook} set={setRepoHook}
              label="Write the team into the repo's CLAUDE.md"
              desc="A marker-bounded block naming the roles and the record. It's what makes the team visible to a bare `claude` in that folder — and it edits a tracked file." />
          )}
          <Check on={sync} set={setSync}
            label="Let the closing role sync the record"
            desc="Off by default: an unattended run pushing to a synced vault is an outward action nobody watched happen. Turn it on once you trust what the team writes." />
        </div>

        {err && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-[11.5px] text-red-300">{err}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-[12px] text-neutral-400 hover:text-neutral-100">Cancel</button>
          <button onClick={submit} disabled={!name.trim() || !templateId || busy}
            className="rounded-lg bg-[var(--sakura)] px-3.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-40">
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>

      {picking && (
        <FolderPicker start={workspace} onClose={() => setPicking(false)}
          onPick={(p) => { setWorkspace(shortPath(p)); setPicking(false); }} />
      )}
    </div>
  );
}

function Check({ on, set, label, desc }: { on: boolean; set: (v: boolean) => void; label: string; desc: string }) {
  return (
    <button onClick={() => set(!on)} className="flex w-full gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-left hover:border-white/15">
      <span className={`mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center rounded border text-[9px] ${on ? "border-[var(--sakura)] bg-[var(--sakura)] text-white" : "border-white/25"}`}>{on ? "✓" : ""}</span>
      <span className="min-w-0">
        <span className="block text-[12px] text-neutral-200">{label}</span>
        <span className="mt-0.5 block text-[10.5px] leading-relaxed text-neutral-600">{desc}</span>
      </span>
    </button>
  );
}
