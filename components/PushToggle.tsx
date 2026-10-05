"use client";
// Settings for web push on THIS device (§24): the on/off switch (which is where the browser's permission
// prompt happens — it must come from a tap) and the device's "finished" notices pref.
import { useEffect, useState } from "react";
import { disablePush, enablePush, getFinishedPref, pushState, setFinishedPref, type PushState } from "@/lib/push-client";

function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  // Same shape as app/settings' Toggle, shrink-0 for the same reason (see the comment there).
  return (
    <button disabled={disabled} onClick={() => onChange(!on)} aria-pressed={on}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? "bg-[var(--sakura)]" : "bg-white/15"}`}>
      <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${on ? "translate-x-[18px]" : "translate-x-0"}`} />
    </button>
  );
}

function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="min-w-[14rem] flex-1"><p className="text-sm font-medium">{title}</p><p className="text-xs text-neutral-500">{desc}</p></div>
      {children}
    </div>
  );
}

const WHY: Record<PushState, string> = {
  unsupported: "This browser can't receive push here. On a phone, open the dashboard through its https tailnet address and install it (Add to Home screen).",
  denied: "Notifications are blocked for this site. Allow them in the browser's site settings, then come back.",
  off: "Buzz this device when a chat needs you — a question, a plan, or a held step. Answers that are safe from a lock screen (Claude's own options, Deny) work from the notification.",
  on: "This device is notified when a chat needs you. Approving anything still means opening the app.",
};

export function PushToggle() {
  const [state, setState] = useState<PushState>("off");
  const [finished, setFinished] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    pushState().then(async (s) => { setState(s); if (s === "on") setFinished(await getFinishedPref()); }).catch(() => setState("unsupported"));
  }, []);

  const flip = async (on: boolean) => {
    setBusy(true); setErr(null);
    try { setState(on ? await enablePush() : await disablePush()); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
    setBusy(false);
  };

  return (
    <div className="space-y-2">
      <Row title="Notifications on this device" desc={err ? `Couldn't subscribe: ${err}` : WHY[state]}>
        <Switch on={state === "on"} onChange={flip} disabled={busy || state === "unsupported" || state === "denied"} />
      </Row>
      {state === "on" && (
        <Row title="Tell me when a long turn finishes" desc="A silent notice when a turn that ran over a minute ends or fails. It never buzzes.">
          <Switch on={finished} onChange={(v) => { setFinished(v); setFinishedPref(v).catch(() => setFinished(!v)); }} />
        </Row>
      )}
    </div>
  );
}

export default PushToggle;
