"use client";
// The Autopilot switch, written for someone who does not know what a merge is.
//
// Two things this UI has to do that a plain toggle wouldn't. First, say what will actually happen in
// the user's own terms — "finished work gets combined into the main copy" beats "merges task branches"
// for the person this feature exists for. Second, show its *current view of the world*: an always-on
// agent that shows no state is indistinguishable from a broken one, and the first question anyone asks
// after switching it on is "so is it doing anything?".
//
// The switch itself lives on the server (~/.minami/autopilot.json), not in localStorage, because the
// thing that reads it is a timer inside next-server — see lib/autopilot/config.ts.
import { useCallback, useEffect, useState } from "react";

type Cfg = { enabled: boolean; merge: boolean; deploy: boolean; resolve: boolean; settleMs: number; everyMs: number };
type Task = { name: string; ahead: string; dirty: boolean; live: boolean | null; lastCommitTs: number };
type Status = {
  config: Cfg;
  inMainCheckout: boolean;
  base: { branch: string; dirty: boolean; merging: boolean } | null;
  tasks: Task[];
  blocked: Record<string, string>;
};

function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button onClick={() => onChange(!on)} disabled={disabled} aria-pressed={on}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? "bg-[var(--sakura)]" : "bg-white/15"}`}>
      <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${on ? "translate-x-[18px]" : "translate-x-0"}`} />
    </button>
  );
}

export default function AutopilotPanel() {
  const [s, setS] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try { setS(await (await fetch("/api/autopilot")).json()); } catch { /* offline is not an error here */ }
  }, []);
  useEffect(() => {
    load();
    // Slow poll: this is a settings page, and the runner's own cadence is 45s. Anything faster would
    // just be a busier-looking way to show the same thing.
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  }, [load]);

  const patch = async (p: Partial<Cfg>) => {
    setSaving(true);
    setS((prev) => (prev ? { ...prev, config: { ...prev.config, ...p } } : prev)); // optimistic: the switch must feel instant
    try { const r = await fetch("/api/autopilot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }); const d = await r.json(); if (d?.config) setS((prev) => (prev ? { ...prev, config: d.config } : prev)); }
    catch { load(); }
    finally { setSaving(false); }
  };

  const cfg = s?.config;
  const on = !!cfg?.enabled;
  const waiting = (s?.tasks || []).filter((t) => !t.dirty && Number(t.ahead) > 0);
  const blockedNames = Object.keys(s?.blocked || {});

  return (
    <section>
      <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">Autopilot</h2>
      <div className="space-y-2">
        <div className={`rounded-xl border px-4 py-3 transition-colors ${on ? "border-[var(--sakura)]/40 bg-[var(--sakura)]/[0.06]" : "border-white/10 bg-white/[0.03]"}`}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Finish my work for me</p>
              <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">
                When a piece of work in its own workspace is finished and sitting still, Autopilot folds it
                into the main copy of the project, sorts out any straightforward overlaps with other work,
                and puts it live. You don&apos;t have to ask for any of it.
              </p>
            </div>
            <Switch on={on} onChange={(v) => patch({ enabled: v })} disabled={saving || !s} />
          </div>

          {on && (
            <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
              {/* Sub-switches, indented under the master: each one is a thing it will stop doing, and
                  they only exist once the answer to "on?" is yes. */}
              {([
                ["merge", "Combine finished work", "Off means it only watches and tells you what's ready."],
                ["resolve", "Sort out overlaps", "When two pieces of work touch the same lines. It only handles the mechanical kind, and rolls back anything it isn't sure about."],
                ["deploy", "Put it live afterwards", "Runs the same deploy you'd trigger by hand, and waits until nothing is mid-conversation."],
              ] as const).map(([k, title, desc]) => (
                <label key={k} className="flex items-start justify-between gap-4">
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-neutral-200">{title}</span>
                    <span className="block text-[11px] leading-relaxed text-neutral-500">{desc}</span>
                  </span>
                  <Switch on={!!cfg?.[k]} onChange={(v) => patch({ [k]: v })} disabled={saving} />
                </label>
              ))}
            </div>
          )}
        </div>

        {/* What it can see. Present whether or not it's on, because "would this even do anything?" is
            the question you want answered BEFORE flipping the switch. */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs">
          {!s ? <p className="text-neutral-500">Checking…</p> : !s.inMainCheckout ? (
            <p className="text-neutral-500">This server is running from a preview workspace, so Autopilot stays out of the way entirely.</p>
          ) : (
            <div className="space-y-1.5">
              <p className="flex items-center gap-2 text-neutral-400">
                <span className={`h-1.5 w-1.5 rounded-full ${on ? "animate-pulse bg-[var(--sakura)]" : "bg-neutral-600"}`} />
                {on ? `Watching · checks every ${Math.round((cfg?.everyMs ?? 45_000) / 1000)}s` : "Off — nothing happens automatically"}
              </p>
              {s.base?.merging && <p className="text-[#f0a868]">The main copy is mid-merge right now. Autopilot won&apos;t touch it until that&apos;s finished.</p>}
              {s.base?.dirty && !s.base?.merging && <p className="text-neutral-500">The main copy has uncommitted changes — Autopilot waits rather than risk them.</p>}
              <p className="text-neutral-500">
                {waiting.length === 0 ? "No finished work waiting." : `${waiting.length} piece(s) of work waiting: ${waiting.map((t) => t.name).join(", ")}`}
              </p>
              {blockedNames.length > 0 && (
                <p className="text-[#f0a868]">
                  Needs you: {blockedNames.join(", ")} — ask a chat to merge it and sort the overlap out.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
