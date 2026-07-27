"use client";

import { Nav } from "@/components/Nav";
import { useSetting } from "@/lib/use-settings";

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className={`relative h-6 w-11 rounded-full transition-colors ${on ? "bg-[--sakura]" : "bg-white/15"}`} style={{ ["--sakura" as string]: "#e8859b" }}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div><p className="text-sm font-medium">{title}</p><p className="text-xs text-neutral-500">{desc}</p></div>
      {children}
    </div>
  );
}

const WINDOWS: { label: string; days: number | null }[] = [
  { label: "24h", days: 1 }, { label: "3d", days: 3 }, { label: "7d", days: 7 }, { label: "30d", days: 30 }, { label: "All", days: null },
];

export default function Settings() {
  const [showTools, setShowTools] = useSetting<boolean>("showToolLogs", false);
  const [defaultWindow, setDefaultWindow] = useSetting<number | null>("defaultWindow", 3);

  return (
    <div className="min-h-screen text-neutral-100" style={{ background: "radial-gradient(1100px 620px at 25% -12%, #1c1622, #0b0a0d 58%)" }}>
      <header className="flex items-center gap-3 px-6 py-5">
        <span className="text-xl">⚙</span>
        <h1 className="text-base font-semibold tracking-tight">Settings</h1>
        <div className="ml-auto"><Nav /></div>
      </header>
      <main className="mx-auto max-w-2xl space-y-6 px-6 pb-16">
        <section>
          <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">Bento</h2>
          <div className="space-y-2">
            <Row title="Default time window" desc="How far back the bento shows on open. Projects older than this are hidden until you widen it.">
              <div className="flex items-center gap-1 rounded-lg border border-white/10 p-0.5">
                {WINDOWS.map((w) => (
                  <button key={w.label} onClick={() => setDefaultWindow(w.days)} className={`rounded-md px-2 py-0.5 text-[11px] transition-all ${defaultWindow === w.days ? "bg-[--sakura] text-white" : "text-neutral-400 hover:text-neutral-200"}`} style={{ ["--sakura" as string]: "#e8859b" }}>{w.label}</button>
                ))}
              </div>
            </Row>
          </div>
        </section>

        <section>
          <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">Chat</h2>
          <div className="space-y-2">
            <Row title="Show tool logs" desc="Show each turn's tool calls (Bash, Edit, Read…) inline in the chat. Off keeps the read cleaner.">
              <Toggle on={showTools} onChange={setShowTools} />
            </Row>
          </div>
        </section>
        <p className="px-1 text-[11px] text-neutral-600">Settings are stored locally in this browser. Bento reads them live.</p>
      </main>
    </div>
  );
}
