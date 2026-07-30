"use client";
// Creating an agent — which is really "choosing a folder and deciding whether we're filling it or
// adopting it".
//
// The folder inspection is live as you type, and that's the point of the dialog rather than a bare
// form: pointing an agent at ~/secondBrain and pointing it at a path that doesn't exist yet are both
// valid and lead to very different outcomes, and you should see which one you're doing *before* you
// press the button, not read about it afterwards.
import FolderPicker from "@/components/FolderPicker";
import { createAgent, inspectFolder, startOnboarding, type FolderReport } from "@/lib/agents/client";
import { useEffect, useState } from "react";

const ICONS = ["◆", "🧠", "🔎", "✍", "⚙", "📊", "🛠", "🎯", "📡", "🗂"];

export default function NewAgent({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [icon, setIcon] = useState(ICONS[0]);
  const [home, setHome] = useState("");
  const [hq, setHq] = useState(false);
  const [picking, setPicking] = useState(false);
  const [report, setReport] = useState<FolderReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Whether to run the interview straight after creating. Default on: a scaffolded folder is a stack
  // of TODOs, and an agent created without the interview is the one that ends up unused.
  const [interview, setInterview] = useState(true);

  useEffect(() => {
    if (!home.trim().startsWith("/") && !home.trim().startsWith("~")) { setReport(null); return; }
    let alive = true;
    const h = setTimeout(() => {
      inspectFolder(home.trim()).then((d) => alive && setReport(d.report)).catch(() => alive && setReport(null));
    }, 250);
    return () => { alive = false; clearTimeout(h); };
  }, [home]);

  const submit = async () => {
    setErr(null); setBusy(true);
    try {
      const { agent } = await createAgent({ name: name.trim(), role: role.trim(), icon, home: home.trim(), hq });
      if (interview) await startOnboarding(agent.id).catch(() => { /* the agent exists either way */ });
      onCreated(agent.id);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      setBusy(false);
    }
  };

  const adopting = report?.suggests === "adopt";
  const ready = name.trim().length > 0 && home.trim().length > 0 && !busy;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-neutral-950 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-neutral-100">New agent</h2>
        <p className="mt-1 text-[11px] text-neutral-500">
          An agent is a name, a home folder it thinks and remembers in, and a model. Everything else it
          learns from you.
        </p>

        <div className="mt-4 space-y-3">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-[10px] uppercase tracking-wider text-neutral-500">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Researcher"
                className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[13px] text-neutral-100 outline-none focus:border-[var(--sakura)]/60" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-neutral-500">Icon</label>
              <div className="mt-1 flex flex-wrap gap-0.5">
                {ICONS.map((i) => (
                  <button key={i} onClick={() => setIcon(i)}
                    className={`h-7 w-7 rounded-md text-sm ${icon === i ? "bg-[var(--sakura)]/25" : "hover:bg-white/10"}`}>{i}</button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-neutral-500">Role — one line</label>
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Digs into markets and competitors, and writes up what it finds"
              className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[13px] text-neutral-100 outline-none focus:border-[var(--sakura)]/60" />
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-neutral-500">Home folder — its brain</label>
            <div className="mt-1 flex gap-1.5">
              <input value={home} onChange={(e) => setHome(e.target.value)} placeholder="/Users/you/brains/researcher"
                className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 font-mono text-[12px] text-neutral-100 outline-none focus:border-[var(--sakura)]/60" />
              <button onClick={() => setPicking(true)} className="rounded-lg border border-white/10 px-2.5 text-[11px] text-neutral-400 hover:text-neutral-200">Browse</button>
            </div>

            {report && (
              <div className={`mt-2 rounded-lg border px-2.5 py-2 text-[11px] ${adopting ? "border-amber-400/25 bg-amber-400/[0.06] text-amber-200/90" : "border-white/10 bg-white/[0.03] text-neutral-400"}`}>
                {adopting ? (
                  <>
                    <b>Adopting an existing folder.</b> Found
                    {report.hasClaudeMd ? " a CLAUDE.md," : ""}
                    {report.hasNotes ? " a note structure," : ""}
                    {report.sessions > 0 ? ` ${report.sessions} past session${report.sessions > 1 ? "s" : ""},` : ""}
                    {` ${report.entries} entries.`}
                    <span className="block text-amber-200/70">
                      Nothing here is overwritten — only missing pieces are added, and the past sessions
                      become this agent&apos;s history.
                    </span>
                  </>
                ) : report.exists ? (
                  <>Empty folder — a fresh brain gets scaffolded here.</>
                ) : (
                  <>Doesn&apos;t exist yet — it&apos;ll be created.</>
                )}
              </div>
            )}
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2">
            <input type="checkbox" checked={hq} onChange={(e) => setHq(e.target.checked)} className="mt-0.5 accent-[var(--sakura)]" />
            <span className="text-[11px] text-neutral-400">
              <b className="text-neutral-200">Make this HQ</b> — the one you talk to. It gets the commands
              for assigning work to the others. Only one agent can be HQ; promoting this one demotes any
              other.
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2">
            <input type="checkbox" checked={interview} onChange={(e) => setInterview(e.target.checked)} className="mt-0.5 accent-[var(--sakura)]" />
            <span className="text-[11px] text-neutral-400">
              <b className="text-neutral-200">Interview me now</b> — it opens its chat and asks who it is,
              then writes its own persona, notes and permissions from your answers. Without this you get
              a folder full of TODOs.
            </span>
          </label>
        </div>

        {err && <p className="mt-3 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">{err}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-[12px] text-neutral-400 hover:text-neutral-200">Cancel</button>
          <button onClick={submit} disabled={!ready}
            className="rounded-lg bg-[var(--sakura)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40">
            {busy ? "Creating…" : adopting ? "Adopt folder" : "Create agent"}
          </button>
        </div>
      </div>

      {picking && (
        <FolderPicker start={home} onClose={() => setPicking(false)} onPick={(p) => { setHome(p); setPicking(false); }} />
      )}
    </div>
  );
}
