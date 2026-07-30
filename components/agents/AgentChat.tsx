"use client";
// An agent's chat pane.
//
// Deliberately thin: `useAgent` already owns everything hard about driving a live session (streaming,
// reconnects, reconciliation from disk, prompts), and the bento's own panes are built on the same
// hook. So this is a renderer, not a second implementation — the one thing it adds is that the pane
// key is derived from the agent id rather than from a tile, which is what makes an agent's
// conversation follow it across pages and survive navigation.
import AskCard from "@/components/AskCard";
import Composer from "@/components/Composer";
import Markdown from "@/components/Markdown";
import ThoughtBlock from "@/components/ThoughtBlock";
import { useSetting } from "@/lib/use-settings";
import { activityLabel, useAgent } from "@/lib/use-agent";
import { useEffect, useRef, useState } from "react";
import type { AgentDef } from "@/lib/agents/types";

export default function AgentChat({ agent, cwd }: { agent: AgentDef; cwd?: string }) {
  // One key per agent, not per tab — the pane is the agent's, and reopening this page reattaches to
  // the same conversation rather than starting a context-less one beside it.
  const paneKey = `agent:${agent.id}:chat`;
  const a = useAgent(paneKey);
  const [draft, setDraft] = useState("");
  const [showTools] = useSetting<boolean>("showToolLogs", false);
  const scroller = useRef<HTMLDivElement>(null);
  const attached = useRef(false);

  // Attach once on mount: an agent's session is usually already alive (the onboarding interview, a
  // task that just ran), and without this the pane would look empty until you typed into it.
  useEffect(() => {
    if (attached.current) return;
    attached.current = true;
    a.attach();
  }, [a]);

  // Follow the tail only while already near it, so scrolling back to re-read something isn't yanked
  // forward by the next streamed token.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [a.turns]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (a.busy) a.queueMessage(text, { cwd: cwd || agent.home, mode: agent.permissionMode });
    else a.send(text, { cwd: cwd || agent.home, mode: agent.permissionMode, resume: a.sessionId || undefined });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {!a.turns.length && (
          <div className="mt-10 text-center text-xs text-neutral-600">
            <p className="text-2xl">{agent.icon}</p>
            <p className="mt-2 text-neutral-400">{agent.name}</p>
            <p className="mt-1">{agent.role || "No role set yet."}</p>
            <p className="mt-4 text-[11px]">Runs in <code className="text-neutral-500">{cwd || agent.home}</code></p>
          </div>
        )}
        {a.turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "flex justify-end" : ""}>
            {t.role === "user" ? (
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--sakura)]/15 px-3.5 py-2 text-[13px] text-neutral-100">
                <Markdown text={t.text} />
              </div>
            ) : (
              <div className="max-w-full text-[13px] text-neutral-200">
                {t.thinking && <div className="mb-2"><ThoughtBlock text={t.thinking} live={!!t.streaming && !t.text} /></div>}
                {showTools && t.tools.map((tool, j) => (
                  <div key={j} className="mb-1 flex items-center gap-2 text-[11px] text-neutral-500">
                    <span className={tool.done ? (tool.ok === false ? "text-red-400" : "text-green-500") : "text-neutral-600"}>
                      {tool.done ? (tool.ok === false ? "✗" : "✓") : "◌"}
                    </span>
                    <span className="truncate">{activityLabel(tool.name, tool.input)}</span>
                  </div>
                ))}
                <Markdown text={t.text} caret={!!t.streaming} />
              </div>
            )}
          </div>
        ))}

        {a.ask && <AskCard questions={a.ask.questions} onAnswer={a.answerAsk} />}

        {a.pending && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[12px]">
            <p className="text-amber-300">{agent.name} wants to run <b>{a.pending.toolName}</b>.</p>
            <div className="mt-2 flex gap-2">
              <button onClick={() => a.respond("allow")} className="rounded-md bg-green-500/20 px-2 py-0.5 text-[11px] text-green-300">Allow</button>
              <button onClick={() => a.respond("deny")} className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] text-neutral-300">Deny</button>
            </div>
          </div>
        )}

        {a.error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{a.error}</p>}
      </div>

      <div className="shrink-0 border-t border-white/[0.07] px-3 py-2">
        {a.busy && (
          <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px] text-neutral-500">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--sakura)]" />
            <span className="truncate">{a.activity.label || "thinking…"}</span>
            <span className="tabular-nums text-neutral-600">{Math.round(a.elapsed / 1000)}s</span>
            <button onClick={a.stop} disabled={a.stopping} className="ml-auto rounded px-1.5 py-0.5 text-neutral-500 hover:text-neutral-200 disabled:opacity-40">
              {a.stopping ? "stopping…" : "stop"}
            </button>
          </div>
        )}
        {a.queued.map((q) => (
          <p key={q.uuid} className="mb-1 truncate px-1 text-[11px] text-neutral-600">queued · {q.text}</p>
        ))}
        <Composer value={draft} onChange={setDraft} onSubmit={send} placeholder={`Message ${agent.name}…`} />
      </div>
    </div>
  );
}
