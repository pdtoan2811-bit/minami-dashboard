"use client";
// Phone access, from the chat panel (§23): is the dashboard reachable from the phone, and a switch.
//
// When the phone couldn't connect there was nothing on this screen to say why, and the three possible
// causes (Tailscale down on the Mac, the dashboard's serve entry missing, the phone itself offline) all
// look identical from the phone — a page that never loads. The dot answers at a glance; the panel
// says which fact is false and flips the one the Mac controls.
import { useCallback, useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { viewedRemotely } from "@/lib/open-local";

type Access = {
  running: boolean; backend: string; serving: boolean; url: string | null; ipUrl: string | null; error?: string;
  devices: { name: string; os: string; online: boolean; lastSeen: string | null }[];
};

function ago(iso: string | null) {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

export function PhoneAccess() {
  const [a, setA] = useState<Access | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => fetch("/api/tailnet/phone").then((r) => r.json()).then(setA).catch(() => {}), []);
  // Slow at rest (it's a status dot), fast while the panel is open (you're waiting on a change).
  useEffect(() => { load(); const iv = setInterval(load, open ? 5000 : 30000); return () => clearInterval(iv); }, [load, open]);

  const flip = async () => {
    if (!a) return;
    const on = !a.serving;
    // Switching off from the phone cuts off the very screen you'd use to switch it back on.
    if (!on && viewedRemotely() && !window.confirm("Turn off phone access? This device will disconnect, and you'll need the Mac to turn it back on.")) return;
    setBusy(true);
    try { setA(await (await fetch("/api/tailnet/phone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) })).json()); }
    finally { setBusy(false); }
  };

  const phonesOnline = a?.devices.filter((d) => d.online).length ?? 0;
  const ok = !!a?.running && !!a?.serving;
  const tint = !a ? "#6b7280" : !ok ? "#ef7c7c" : phonesOnline ? "#4ade80" : "#f0a868";
  const why = !a ? "checking…" : !a.running ? `Tailscale isn't running on this Mac (${a.backend})` : !a.serving ? "Phone access is off — the dashboard isn't on the tailnet"
    : phonesOnline ? `On · ${phonesOnline} phone${phonesOnline > 1 ? "s" : ""} online` : "On, but no phone is online — open the Tailscale app on the phone and switch it on";

  return (
    <div className="relative shrink-0">
      <button onClick={() => setOpen((v) => !v)} title={`Phone access — ${why}`} aria-label="Phone access"
        className="relative flex items-center rounded-lg border border-white/10 px-2 py-1 text-neutral-400 transition-colors hover:border-white/25 hover:text-neutral-200 pointer-coarse:px-3 pointer-coarse:py-2">
        <Smartphone className="h-3.5 w-3.5" />
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-neutral-900" style={{ background: tint }} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-30 mt-1 w-80 rounded-xl border border-white/10 bg-neutral-900 p-3 text-[12px] shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-neutral-100">Phone access</p>
                <p className="mt-0.5 text-neutral-400" style={{ color: ok ? undefined : tint }}>{why}</p>
              </div>
              {/* The switch. Tailnet-only either way — this never opens anything to the internet. */}
              <button onClick={flip} disabled={!a || busy || !a.running && !!a.serving} role="switch" aria-checked={!!a?.serving}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${a?.serving ? "bg-[#4ade80]/80" : "bg-white/15"}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${a?.serving ? "left-[22px]" : "left-0.5"}`} />
              </button>
            </div>
            {a?.url && (
              <button onClick={() => { navigator.clipboard?.writeText(a.url!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
                className="mt-3 w-full truncate rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-left font-mono text-[11px] text-neutral-300 hover:border-white/25" title="Copy — open this on the phone">
                {copied ? "copied ✓" : a.url}
              </button>
            )}
            {a?.ipUrl && (
              <p className="mt-2 text-[11px] leading-snug text-neutral-500">
                Name won&apos;t load on the phone? Android&apos;s <b className="text-neutral-400">Private DNS</b> blocks Tailscale names — set it to Off, or use{" "}
                <button onClick={() => navigator.clipboard?.writeText(a.ipUrl!)} className="font-mono text-neutral-300 underline decoration-white/20 underline-offset-2" title="Copy">{a.ipUrl}</button>
                {" "}(works as a tab; installing needs the https name).
              </p>
            )}
            {a && a.devices.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {a.devices.map((d) => (
                  <li key={d.name} className="flex items-center gap-2 text-neutral-300">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: d.online ? "#4ade80" : "#6b7280" }} />
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                    <span className="shrink-0 text-[11px] text-neutral-500">{d.online ? "online" : d.lastSeen ? `seen ${ago(d.lastSeen)}` : "offline"}</span>
                  </li>
                ))}
              </ul>
            )}
            {a?.error && <p className="mt-2 text-[11px] text-[#ef7c7c]">{a.error}</p>}
            <p className="mt-3 text-[11px] leading-snug text-neutral-500">Still can&apos;t connect? On the phone, open Tailscale and make sure it says Connected, then reload the app.</p>
          </div>
        </>
      )}
    </div>
  );
}
