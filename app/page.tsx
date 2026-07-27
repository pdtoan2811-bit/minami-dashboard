import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ModelRouting } from "@/components/ModelRouting";
import { RoutingFlow } from "@/components/RoutingFlow";
import { analytics, people, taskLog, tokenLog, traceBack } from "@/lib/data";
import { Activity, GitBranch, ListTodo, Radio, Route, Users, Zap } from "lucide-react";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className="text-2xl font-semibold tracking-tight">{value}</span>
      {sub && <span className="text-xs text-neutral-400">{sub}</span>}
    </div>
  );
}

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-md px-4 pb-16 pt-8 lg:max-w-5xl xl:max-w-6xl">
      <header className="mb-4 flex items-center gap-2 lg:mb-6">
        <span className="text-2xl lg:text-3xl">🌸</span>
        <div>
          <h1 className="text-lg font-semibold tracking-tight lg:text-2xl">Minami Dashboard</h1>
          <p className="text-xs text-neutral-500">Holding the thread · live snapshot · 2026-07-27</p>
        </div>
      </header>

      {/* Masonry: 1 column on mobile, 2 on tablet, 3 on desktop. Cards never split across columns. */}
      <div className="gap-4 [column-fill:_balance] md:columns-2 xl:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
      <Card>
        <CardHeader><Radio className="h-4 w-4 text-[--sakura]" /><CardTitle>Live routing</CardTitle></CardHeader>
        <CardContent><RoutingFlow /></CardContent>
      </Card>

      <Card>
        <CardHeader><Route className="h-4 w-4 text-[--sakura]" /><CardTitle>Model routing</CardTitle></CardHeader>
        <CardContent><ModelRouting /></CardContent>
      </Card>

      <Card>
        <CardHeader><Zap className="h-4 w-4 text-[--sakura]" /><CardTitle>Token log</CardTitle></CardHeader>
        <CardContent>
          {tokenLog.connected ? null : (
            <p className="text-sm text-neutral-400">No usage source connected yet — per-session cost lands here once Minami logs it.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><ListTodo className="h-4 w-4 text-[--sakura]" /><CardTitle>Task log</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2">
          {taskLog.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate">{t.title}</span>
              <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 dark:bg-white/10">{t.status}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><GitBranch className="h-4 w-4 text-[--sakura]" /><CardTitle>Trace-back</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2">
          {traceBack.map((t) => (
            <div key={t.id} className="text-sm">
              <span className="font-medium">{t.chat}</span>
              <span className="text-neutral-400"> → {t.where}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><Activity className="h-4 w-4 text-[--sakura]" /><CardTitle>Analytics</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <Stat label="Active projects" value={String(analytics.activeProjects)} />
          <Stat label="Open tasks" value={String(analytics.openTasks)} />
          <Stat label="Notes" value={String(analytics.notesTotal)} />
          <Stat label="Captures / 7d" value={String(analytics.captureRate7d)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><Users className="h-4 w-4 text-[--sakura]" /><CardTitle>People around me</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2">
          {people.map((p) => (
            <div key={p.id} className="flex items-center justify-between text-sm">
              <span>{p.name}</span>
              <span className="text-xs text-neutral-400">{p.relation} · {p.lastTouch}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      </div>
    </main>
  );
}
