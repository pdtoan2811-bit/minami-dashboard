"use client";

import { Nav } from "@/components/Nav";
import { useSetting } from "@/lib/use-settings";

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className={`relative h-6 w-11 rounded-full transition-colors ${on ? "bg-[var(--sakura)]" : "bg-white/15"}`}>
      <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${on ? "translate-x-[18px]" : "translate-x-0"}`} />
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
  // Same key and same default as the composer's pills (app/page.tsx) — this is the seed a NEW chat
  // starts from, not a retroactive change to sessions already running.
  const [permDefault, setPermDefault] = useSetting<"default" | "acceptEdits" | "bypassPermissions">("permMode", "bypassPermissions");
  const [defaultWindow, setDefaultWindow] = useSetting<number | null>("defaultWindow", 3);

  return (
    <div className="bg-bento min-h-screen text-neutral-100">
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
                  <button key={w.label} onClick={() => setDefaultWindow(w.days)} className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${defaultWindow === w.days ? "bg-[var(--sakura)] text-white" : "text-neutral-400 hover:text-neutral-200"}`}>{w.label}</button>
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
            <Row title="Approval level for new chats"
              desc="Bypass auto-runs every tool with no prompt — the default here, and the reason this dashboard is local-only. Existing chats keep the level shown on their own pills.">
              <div className="flex items-center gap-1 rounded-lg border border-white/10 p-0.5">
                {([["default", "ask"], ["acceptEdits", "auto-edits"], ["bypassPermissions", "bypass"]] as const).map(([m, label]) => (
                  <button key={m} onClick={() => setPermDefault(m)}
                    className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${permDefault === m
                      ? (m === "bypassPermissions" ? "bg-green-500/20 text-green-400" : "bg-[var(--sakura)] text-white")
                      : "text-neutral-400 hover:text-neutral-200"}`}>{label}</button>
                ))}
              </div>
            </Row>
          </div>
        </section>
        <p className="px-1 text-[11px] text-neutral-600">Settings are stored locally in this browser. Bento reads them live.</p>
      </main>
    </div>
  );
}
