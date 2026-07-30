import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Nav } from "@/components/Nav";
import { ModelRouting } from "@/components/ModelRouting";
import { RoutingFlow } from "@/components/RoutingFlow";
import { UsagePanel } from "@/components/UsagePanel";
import { UsageHeatmap } from "@/components/UsageHeatmap";
import { AccountsPanel } from "@/components/AccountsPanel";
import { ProjectsPanel } from "@/components/ProjectsPanel";
import { getPanels } from "@/lib/panels";
import { Activity, CalendarDays, FolderClock, GitBranch, KeyRound, ListTodo, Radio, Route, Users, Zap } from "lucide-react";

export const dynamic = "force-dynamic"; // panels are read from disk at request time
export const runtime = "nodejs";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className="text-2xl font-semibold tracking-tight">{value}</span>
      {sub && <span className="text-xs text-neutral-400">{sub}</span>}
    </div>
  );
}

// The personal panels (task log, trace-back, analytics, people) are all fed by MINAMI_PANELS_FILE, so
// on an unconfigured box they were four full-height cards carrying four copies of one sentence —
// roughly a third of the board spent telling you the same thing. They now collapse into this single
// card, which says it once and names what you'd get. A panel with data renders normally and drops out
// of the list, so a partly-configured file shows real panels plus a shorter note.
function UnconfiguredPanels({ names }: { names: string[] }) {
  return (
    <Card>
      <CardHeader><ListTodo className="h-4 w-4 text-neutral-600" /><CardTitle>Personal panels</CardTitle></CardHeader>
      <CardContent>
        <p className="text-xs leading-relaxed text-neutral-400">
          {names.join(" · ")} {names.length === 1 ? "is" : "are"} empty. Point{" "}
          <code className="text-[11px] text-neutral-300">MINAMI_PANELS_FILE</code> at a JSON file (see{" "}
          <code className="text-[11px] text-neutral-300">panels.example.json</code>) to fill{" "}
          {names.length === 1 ? "it" : "them"} in.
        </p>
      </CardContent>
    </Card>
  );
}

export default function Page() {
  const { taskLog = [], people = [], traceBack = [], analytics } = getPanels();
  const unconfigured = [
    taskLog.length === 0 && "Task log",
    traceBack.length === 0 && "Trace-back",
    !analytics && "Analytics",
    people.length === 0 && "People around me",
  ].filter((x): x is string => typeof x === "string");

  return (
    <main className="mx-auto w-full max-w-md px-4 pb-16 pt-8 lg:max-w-5xl xl:max-w-6xl">
      <header className="mb-4 flex items-center gap-2 lg:mb-6">
        <span className="text-2xl lg:text-3xl">🌸</span>
        <div className="flex-1">
          <h1 className="text-lg font-semibold tracking-tight lg:text-2xl">Minami · Metrics</h1>
          <p className="text-xs text-neutral-500">Live usage & model routing across your machines</p>
        </div>
        <Nav />
      </header>

      {/* Masonry: 1 column on mobile, 2 on tablet, 3 on desktop. Cards never split across columns. */}
      <div className="gap-4 [column-fill:_balance] md:columns-2 xl:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
      <Card>
        <CardHeader><CalendarDays className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>Usage heatmap</CardTitle></CardHeader>
        <CardContent><UsageHeatmap /></CardContent>
      </Card>

      <Card>
        <CardHeader><Radio className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>Live routing</CardTitle></CardHeader>
        <CardContent><RoutingFlow /></CardContent>
      </Card>

      <Card>
        <CardHeader><Route className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>Model routing</CardTitle></CardHeader>
        <CardContent><ModelRouting /></CardContent>
      </Card>

      <Card>
        <CardHeader><Zap className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>Usage · both machines</CardTitle></CardHeader>
        <CardContent><UsagePanel /></CardContent>
      </Card>

      <Card>
        <CardHeader><KeyRound className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>Accounts · token-slayer</CardTitle></CardHeader>
        <CardContent><AccountsPanel /></CardContent>
      </Card>

      <Card>
        <CardHeader><FolderClock className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>Projects · last touched</CardTitle></CardHeader>
        <CardContent><ProjectsPanel /></CardContent>
      </Card>

      {taskLog.length > 0 && (
        <Card>
          <CardHeader><ListTodo className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>Task log</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2">
            {taskLog.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">{t.title}</span>
                {t.status && <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-xs text-neutral-400">{t.status}</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {traceBack.length > 0 && (
        <Card>
          <CardHeader><GitBranch className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>Trace-back</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2">
            {traceBack.map((t) => (
              <div key={t.id} className="text-sm">
                <span className="font-medium">{t.chat}</span>
                {t.where && <span className="text-neutral-400"> → {t.where}</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {analytics && (
        <Card>
          <CardHeader><Activity className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>Analytics</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <Stat label="Active projects" value={String(analytics.activeProjects ?? 0)} />
            <Stat label="Open tasks" value={String(analytics.openTasks ?? 0)} />
            <Stat label="Notes" value={String(analytics.notesTotal ?? 0)} />
            <Stat label="Captures / 7d" value={String(analytics.captureRate7d ?? 0)} />
          </CardContent>
        </Card>
      )}

      {people.length > 0 && (
        <Card>
          <CardHeader><Users className="h-4 w-4 text-[var(--sakura)]" /><CardTitle>People around me</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2">
            {people.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-sm">
                <span>{p.name}</span>
                <span className="text-xs text-neutral-400">{p.relation}{p.lastTouch ? ` · ${p.lastTouch}` : ""}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {unconfigured.length > 0 && <UnconfiguredPanels names={unconfigured} />}
      </div>
    </main>
  );
}
