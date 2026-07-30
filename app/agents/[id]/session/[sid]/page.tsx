"use client";
// One of an agent's transcripts, read-only.
//
// This exists because the History tab was a list of links to nowhere. Every row pointed at
// `/?session=<id>`, and nothing in the app has ever handled a `session` query param — the board just
// opened as normal, so the whole tab looked functional and did nothing. Two ways out: delete the
// links, or give them somewhere to land. A history you can't open isn't a history, so: somewhere to
// land.
//
// Read-only on purpose. Continuing one of these conversations is what the agent's Chat tab is for,
// and offering "resume" from here would give one agent two live panes onto the same transcript —
// exactly the two-writers case manager.ts refuses.
import Markdown from "@/components/Markdown";
import { Nav } from "@/components/Nav";
import { activityLabel } from "@/lib/use-agent";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

type Turn = { role: "user" | "assistant"; text: string; tools: { name: string; input: unknown; ok?: boolean }[]; ts: number };
type Meta = { title: string; cwd: string; model: string; tier: string; cost: number; messages: number; lastActivity: number };

export default function AgentSession() {
  const { id, sid } = useParams<{ id: string; sid: string }>();
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/bento/session/${sid}`)
      .then((r) => r.json())
      .then((d) => { if (!alive) return; setTurns(d.turns || []); setMeta(d.meta || null); })
      .catch((e) => alive && setErr(String(e?.message || e)));
    return () => { alive = false; };
  }, [sid]);

  return (
    <div className="bg-bento min-h-screen text-neutral-100">
      <header className="flex items-center gap-3 px-6 py-4">
        <Link href={`/agents/${id}?tab=history`} className="text-neutral-600 hover:text-neutral-300">←</Link>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-tight">{meta?.title || "Transcript"}</h1>
          <p className="truncate text-[11px] text-neutral-600">
            {meta ? `${meta.cwd} · ${meta.tier} · ${meta.messages} messages · $${meta.cost.toFixed(2)}` : sid}
          </p>
        </div>
        <div className="ml-auto"><Nav /></div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-6 pb-16">
        {err && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{err}</p>}
        {!turns && !err && <p className="text-[12px] text-neutral-600">Reading the transcript…</p>}
        {turns?.length === 0 && <p className="text-[12px] text-neutral-600">This transcript is empty.</p>}
        {turns?.map((t, i) => (
          <div key={i} className={t.role === "user" ? "flex justify-end" : ""}>
            {t.role === "user" ? (
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--sakura)]/15 px-3.5 py-2 text-[13px]">
                <Markdown text={t.text} />
              </div>
            ) : (
              <div className="text-[13px] text-neutral-200">
                {t.tools?.map((tool, j) => (
                  <div key={j} className="mb-1 flex items-center gap-2 text-[11px] text-neutral-500">
                    <span className={tool.ok === false ? "text-red-400" : "text-green-500/70"}>{tool.ok === false ? "✗" : "✓"}</span>
                    <span className="truncate">{activityLabel(tool.name, tool.input)}</span>
                  </div>
                ))}
                <Markdown text={t.text} />
              </div>
            )}
          </div>
        ))}
      </main>
    </div>
  );
}
