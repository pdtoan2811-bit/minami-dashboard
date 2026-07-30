"use client";
// An agent's config, edited in place.
//
// Everything here takes effect on the agent's NEXT run, never on one already in flight — a live
// session keeps the model, cwd and permission mode it was born with, exactly as manager.ts describes.
// The form says so rather than pretending otherwise, because "I changed the model and it kept using
// the old one" is the confusion this design invites.
import FolderPicker from "@/components/FolderPicker";
import { patchAgent, removeAgent, shortPath, startOnboarding, type AgentDef } from "@/lib/agents/client";
import { SELECTABLE_MODELS } from "@/lib/model-catalog";
import { useState } from "react";

const MODES: { id: AgentDef["permissionMode"]; label: string; note: string }[] = [
  { id: "bypassPermissions", label: "bypass", note: "Runs every tool with no prompt. The box default." },
  { id: "acceptEdits", label: "auto-edits", note: "Edits apply freely; other tools ask." },
  { id: "default", label: "ask", note: "Asks before every tool. Unusable for unattended tasks." },
  { id: "plan", label: "plan", note: "Reads and plans, never writes." },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3">
      <p className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</p>
      {hint && <p className="mt-0.5 text-[11px] text-neutral-600">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

export default function AgentConfig({ agent, onChange }: { agent: AgentDef; onChange: (a: AgentDef) => void }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picking, setPicking] = useState<null | "home" | "workspace">(null);
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true); setErr(null);
    try { onChange((await patchAgent(agent.id, patch)).agent); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-3 overflow-y-auto p-4">
      <Field label="Identity">
        <div className="space-y-2">
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== agent.name && save({ name: name.trim() })}
            className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--sakura)]/60" />
          <input value={role} onChange={(e) => setRole(e.target.value)} onBlur={() => role !== agent.role && save({ role })} placeholder="One line: what this agent owns"
            className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] outline-none focus:border-[var(--sakura)]/60" />
        </div>
      </Field>

      <Field label="Home" hint="Its brain — where it thinks and remembers, wherever it's working. Moving this moves its memory and its history; nothing is copied.">
        <div className="flex gap-1.5">
          <code className="flex-1 truncate rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11.5px] text-neutral-300">{shortPath(agent.home)}</code>
          <button onClick={() => setPicking("home")} className="rounded-lg border border-white/10 px-2.5 text-[11px] text-neutral-400 hover:text-neutral-200">Change</button>
        </div>
      </Field>

      <Field label="Workspaces" hint="Folders it may be assigned work in. Enforced — a task pointed anywhere else is refused, not silently redirected.">
        <div className="space-y-1">
          {agent.workspaces.map((w) => (
            <div key={w} className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-2.5 py-1">
              <code className="flex-1 truncate text-[11.5px] text-neutral-300">{shortPath(w)}</code>
              <button onClick={() => save({ workspaces: agent.workspaces.filter((x) => x !== w) })}
                className="text-[11px] text-neutral-600 hover:text-red-400">remove</button>
            </div>
          ))}
          <button onClick={() => setPicking("workspace")} className="rounded-lg border border-dashed border-white/15 px-2.5 py-1 text-[11px] text-neutral-500 hover:text-neutral-300">
            + Add a workspace
          </button>
        </div>
      </Field>

      <Field label="Model" hint="Applies to its next run. A session already open keeps the model it started on.">
        <div className="space-y-1">
          {SELECTABLE_MODELS.map((m) => (
            <button key={m.id} onClick={() => save({ model: m.id })}
              className={`flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                agent.model === m.id ? "bg-[var(--sakura)]/15 text-neutral-100" : "hover:bg-white/5 text-neutral-400"}`}>
              <span className="text-[12px] font-medium">{m.label}</span>
              <span className="truncate text-[10.5px] text-neutral-600">{m.note}</span>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Approval level" hint="What it may run without asking. Unattended tasks can't answer a prompt, so anything but bypass will stall them.">
        <div className="flex flex-wrap gap-1">
          {MODES.map((m) => (
            <button key={m.id} onClick={() => save({ permissionMode: m.id })} title={m.note}
              className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                agent.permissionMode === m.id
                  ? m.id === "bypassPermissions" ? "bg-green-500/20 text-green-400" : "bg-[var(--sakura)] text-white"
                  : "text-neutral-400 hover:text-neutral-200"}`}>
              {m.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Role in the roster">
        <label className="flex cursor-pointer items-start gap-2">
          <input type="checkbox" checked={agent.hq} onChange={(e) => save({ hq: e.target.checked })} className="mt-0.5 accent-[var(--sakura)]" />
          <span className="text-[11px] text-neutral-400">
            <b className="text-neutral-200">HQ</b> — the agent you talk to. Promoting it appends the
            delegation commands to its CLAUDE.md and demotes whichever agent was HQ before.
          </span>
        </label>
      </Field>

      <Field label="Its brain" hint="The folder is the real config — persona, notes, permissions. The interview is how it gets written.">
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => startOnboarding(agent.id).catch((e) => setErr(String(e?.message || e)))}
            className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-300 hover:border-[var(--sakura)]/50">
            {agent.onboardedAt ? "Re-run the interview" : "Run the interview"}
          </button>
          <span className="self-center text-[10.5px] text-neutral-600">
            {agent.onboardedAt ? `last run ${new Date(agent.onboardedAt).toLocaleDateString()}` : "never run — its CLAUDE.md is still TODOs"}
          </span>
        </div>
      </Field>

      <Field label="Remove" hint="Takes it off the roster. Its folder — the notes, the memory, the work — is never touched, so re-adopting the same path brings it back.">
        {confirmDelete ? (
          <div className="flex gap-1.5">
            <button onClick={async () => { await removeAgent(agent.id); window.location.href = "/agents"; }}
              className="rounded-lg bg-red-500/20 px-2.5 py-1 text-[11px] text-red-300">Remove {agent.name}</button>
            <button onClick={() => setConfirmDelete(false)} className="rounded-lg px-2.5 py-1 text-[11px] text-neutral-400">Cancel</button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-500 hover:text-red-400">
            Remove from roster
          </button>
        )}
      </Field>

      {err && <p className="rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">{err}</p>}
      {saving && <p className="px-1 text-[10.5px] text-neutral-600">saving…</p>}

      {picking && (
        <FolderPicker
          start={picking === "home" ? agent.home : ""}
          onClose={() => setPicking(null)}
          onPick={(p) => {
            save(picking === "home" ? { home: p } : { workspaces: [...new Set([...agent.workspaces, p])] });
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}
