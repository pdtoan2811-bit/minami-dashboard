"use client";

import { Nav } from "@/components/Nav";
import { Segmented } from "@/components/ui/Segmented";
import { useSetting } from "@/lib/use-settings";
import AutopilotPanel from "@/components/AutopilotPanel";
import PreferredAccountPanel from "@/components/PreferredAccountPanel";

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    // shrink-0 is load-bearing, the same way it is in `Segmented`. This sits in a `justify-between`
    // row beside a description paragraph, so as a flex item it defaults to shrink:1 — and a row whose
    // text is long enough to overflow pays for it out of the toggle. The track collapsed from 44px to
    // 25px on "Agent view" (two-line description) while "Show tool logs" stayed 44px, and since the
    // knob is absolutely positioned at a fixed 20px it kept its size: what's left reads as a bare
    // circle, not a switch. The width is the control's meaning here — there is nowhere for the knob
    // to travel — so it must never be the thing that gives.
    <button onClick={() => onChange(!on)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-[var(--sakura)]" : "bg-white/15"}`}>
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
  // Same key the Nav reads. Client-only: it decides what this browser shows, not what the server runs
  // — agents already on the roster keep working with this off.
  const [agentMode, setAgentMode] = useSetting<boolean>("agentMode", false);

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
              <Segmented value={defaultWindow} onChange={setDefaultWindow}
                options={WINDOWS.map((w) => ({ value: w.days, label: w.label }))} />
            </Row>
          </div>
        </section>

        <section>
          <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">Agents</h2>
          <div className="space-y-2">
            <Row title="Agent view"
              desc="Adds a roster of standing agents — each with its own home folder, memory and model — and the Teams view built on them, alongside the session board. Off hides both nav entries; it doesn't delete anything, and runs already in flight keep going.">
              <Toggle on={agentMode} onChange={setAgentMode} />
            </Row>
            {agentMode && (
              <>
                <a href="/agents" className="block rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-[11px] text-neutral-400 hover:border-[var(--sakura)]/40">
                  Open the roster →
                </a>
                <a href="/teams" className="block rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-[11px] text-neutral-400 hover:border-[var(--sakura)]/40">
                  Open Teams — products, templates and runs →
                </a>
              </>
            )}
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
              {/* Segmented is `shrink-0 whitespace-nowrap`, which is what stops "auto-edits" wrapping
                  mid-word inside its own segment — this Row is `justify-between` next to three lines
                  of description, and flex was shrinking the control to pay for them. */}
              <Segmented value={permDefault} onChange={setPermDefault}
                options={[
                  { value: "default", label: "ask" },
                  { value: "acceptEdits", label: "auto-edits" },
                  { value: "bypassPermissions", label: "bypass", tone: "good" },
                ] as const} />
            </Row>
          </div>
        </section>
        <PreferredAccountPanel />
        <AutopilotPanel />

        <p className="px-1 text-[11px] text-neutral-600">
          Settings are stored locally in this browser. Bento reads them live. Autopilot and the
          preferred account are the exceptions — they live on the machine, because the things that
          obey them run there.
        </p>
      </main>
    </div>
  );
}
