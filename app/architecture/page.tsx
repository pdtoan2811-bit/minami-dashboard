import { ModuleGraph } from "@/components/ModuleGraph";
import { Nav } from "@/components/Nav";
import { LAYERS } from "@/lib/module-graph";

export const metadata = {
  title: "Architecture — Minami Bento",
  description: "Interactive module map: every file and the edges between them, extracted from source.",
};

export default function ArchitecturePage() {
  return (
    <main className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">Architecture</h1>
          <p className="text-[11px] text-neutral-500">
            Modules and the edges between them, extracted from the source. Click a node to isolate
            what touches it.{" "}
            <a href="/architecture.html" className="text-neutral-400 underline underline-offset-2">
              the written explainer
            </a>{" "}
            covers the why.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden items-center gap-2.5 font-mono text-[10px] text-neutral-500 lg:flex">
            {LAYERS.map((l) => (
              <span key={l.id} title={l.hint}>{l.label}</span>
            ))}
          </div>
          <Nav />
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <ModuleGraph />
      </div>
    </main>
  );
}
