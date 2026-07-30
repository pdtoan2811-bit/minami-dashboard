"use client";

import { useCallback, useEffect, useState } from "react";

type Usage = { utilization: number; resets_at: number } | null;
type Account = {
  index: number;
  name: string;
  alias: string | null;
  email: string | null;
  active: boolean;
  state: string;
  usage: { five_hour: Usage; seven_day: Usage; token_expired: boolean } | null;
};
type StatusDoc = { active: string; accounts: Account[]; error?: string };

const POLL_MS = 30_000;

function fmtResets(ts?: number) {
  if (!ts) return "";
  const ms = ts * 1000 - Date.now();
  if (ms <= 0) return "resetting…";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function Bar({ label, usage }: { label: string; usage: Usage }) {
  const pct = usage ? Math.min(100, Math.round(usage.utilization)) : 0;
  const hot = pct >= 80;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between text-[10px] text-neutral-500">
        <span>{label}</span>
        <span className="tabular-nums">{usage ? `${pct}%` : "—"}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, background: hot ? "#ef4444" : "var(--sakura)" }}
        />
      </div>
      {usage && <span className="text-[9px] text-neutral-400">{fmtResets(usage.resets_at)}</span>}
    </div>
  );
}

export function AccountsPanel() {
  const [doc, setDoc] = useState<StatusDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((d: StatusDoc) => {
        if (d.error) { setError(d.error); return; }
        setError(null);
        setDoc(d);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const doSwitch = async (target: string) => {
    setSwitching(target);
    try {
      const r = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "switch failed");
      load();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setSwitching(null);
    }
  };

  if (error) {
    return (
      <p className="text-xs text-neutral-400">
        token-slayer unavailable on this machine ({error}). This panel is local-only — it shells out
        to the <code className="text-[11px]">token-slayer</code> CLI.
      </p>
    );
  }

  if (!doc) return <p className="text-xs text-neutral-400">Loading account pool…</p>;

  return (
    <div className="flex flex-col gap-2">
      {doc.accounts.map((a) => (
        <div
          key={a.index}
          className={`rounded-lg border p-2 ${a.active ? "border-[var(--sakura)]/50 bg-[var(--sakura)]/5" : "border-white/10"}`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 truncate text-xs font-medium">
              {a.active && <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />}
              {a.alias || a.email || a.name}
            </span>
            {a.active ? (
              <span className="shrink-0 rounded-full bg-[var(--sakura)]/15 px-2 py-0.5 text-[10px] text-[var(--sakura)]">active</span>
            ) : (
              <button
                onClick={() => doSwitch(a.email || a.name)}
                disabled={switching !== null}
                className="shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-[var(--sakura)] hover:text-[var(--sakura)] disabled:opacity-40"
              >
                {switching === (a.email || a.name) ? "switching…" : "switch"}
              </button>
            )}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Bar label="5h" usage={a.usage?.five_hour ?? null} />
            <Bar label="7d" usage={a.usage?.seven_day ?? null} />
          </div>
        </div>
      ))}
      {doc.accounts.length === 0 && <p className="text-xs text-neutral-400">No account slots configured yet.</p>}
    </div>
  );
}
