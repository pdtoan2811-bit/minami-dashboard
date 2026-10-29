"use client";
// A topic's tile, expanded in place in the bento (§37): Topic › Task › chats without leaving the grid.
// Thomas, 2026-10-28: "the bento tile expand to show task with task UI components — but don't hide other
// topics for navigation". So this is a grid cell (the other tiles reflow around it, still clickable),
// not an overlay and not a screen. A task is a thread (lib/threads.ts) — derived from chats he already
// had, so the card list is full the first time it opens and nothing has to be created by hand.
// "Board" goes one step further, to the project's kanban (Board.tsx), for when he wants to focus.
import { useEffect, useState } from "react";
import { startAsk, startInBackground } from "@/lib/ask";
import { useSetting } from "@/lib/use-settings";
import { ensureDod, useThreads, type ThreadView } from "@/lib/use-threads";
import type { AgentMode } from "@/lib/use-agent";
import { TaskCard } from "./TaskCard";
import { NewTask, readDraft, restoreDraft } from "./NewTask";

const btn = "shrink-0 rounded-lg border border-white/12 px-2.5 py-1 text-[12px] text-neutral-200 transition-colors hover:border-white/30 pointer-coarse:py-2";

export function TopicTasks({ project, cwd, tasks, onAllChats, onBoard, onClose, openSids = [] }: {
  project: string; cwd: string; tasks: ThreadView[]; onAllChats: () => void; onBoard: () => void; onClose: () => void;
  /** Sessions open in the chat panel: their task is ringed and says "chatting now". */
  openSids?: string[];
}) {
  const [perm] = useSetting<Exclude<AgentMode, "plan">>("permMode", "bypassPermissions");
  const [model] = useSetting<string | null>("chatModel", null);
  const td = useThreads();
  const busy = new Set(td?.busy ?? []);
  const doneToday = (td?.done ?? []).filter((t) => t.project === project && (t.doneAt ?? 0) > Date.now() - 86_400_000).length;
  const [writing, setWriting] = useState(false);
  // Re-read when the sheet closes, so the trigger shows the draft that was just left behind.
  const [draft, setDraft] = useState("");
  useEffect(() => { if (!writing) setDraft(readDraft(project)); }, [writing, project]);
  const [more, setMore] = useState(false);
  const open = tasks.filter((t) => t.state !== "queued");
  const shown = more ? open : open.slice(0, 6);
  // The task whose chat is open scrolls into view inside the tile, so "which one am I in" is answered
  // without hunting through the list.
  const activeId = open.find((t) => t.sessions.some((x) => openSids.includes(x.id)))?.id;
  useEffect(() => {
    if (activeId) document.querySelector(`[data-expanded] [data-task="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId]);
  useEffect(() => { ensureDod(shown); }, [shown.map((t) => t.id + t.at).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = (text: string) => void startAsk({ project, cwd, at: 0 }, text, { mode: perm, model });
  const met = open.reduce((n, t) => n + (t.dod?.filter((d) => d.done).length ?? 0), 0);
  const all = open.reduce((n, t) => n + (t.dod?.length ?? 0), 0);
  return (
    <div className="flex h-full min-h-0 flex-col rounded-[1.4rem] border border-[var(--sakura)]/50 bg-neutral-900/70 p-4">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{project}
          <span className="ml-2 text-[12px] font-normal text-neutral-500">{open.length} task{open.length === 1 ? "" : "s"}{all ? ` · ${met}/${all} done-items met` : ""}</span>
          {doneToday > 0 && <button onClick={onBoard} className="ml-2 text-[12px] font-normal text-[#4ade80]/80 hover:text-[#4ade80]" title="Finished tasks are on the board's Done column">✓ {doneToday} done today</button>}
        </p>
        <button onClick={onBoard} className={`${btn} border-[var(--sakura)]/40`} title="Focus on this project: its tasks as a board">⤢ Board</button>
        <button onClick={onAllChats} className={btn} title="Open the topic's chat panel, as a tile click used to">All chats</button>
        <button onClick={() => send("Pull the latest code and let me preview it.")} className={`${btn} hidden @min-[640px]:block`}>▶ Preview</button>
        <button onClick={onClose} className="shrink-0 px-1.5 text-neutral-500 hover:text-neutral-200" aria-label="Collapse">✕</button>
      </div>

      {/* A new task is just a new chat in this topic: it becomes a card here the moment it has a reply.
          The field is a trigger for the New task sheet — a task is usually paragraphs and screenshots,
          which a one-line input can't hold. A left-behind draft shows here so it isn't forgotten. */}
      <button onClick={() => setWriting(true)} autoFocus={open.length === 0}
        className="group mt-3 flex w-full items-center gap-2.5 rounded-xl border border-dashed border-white/15 bg-black/20 px-3 py-2 text-left transition-colors hover:border-[var(--sakura)]/50 hover:bg-black/30 focus:border-[var(--sakura)]/50 focus:outline-none">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--sakura)]/15 text-[14px] text-[var(--sakura)]">＋</span>
        {draft.trim()
          ? <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-200"><span className="text-[var(--sakura)]">Draft · </span>{draft.trim().split("\n")[0]}</span>
          : <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-500 group-hover:text-neutral-300">New task in {project} — describe it, paste screenshots…</span>}
        <span className="shrink-0 text-[11px] text-neutral-600">{draft.trim() ? "continue ›" : "write ›"}</span>
      </button>
      <NewTask project={project} open={writing} onClose={() => setWriting(false)}
        onStart={(t) => startInBackground({ project, cwd, at: 0 }, t, { mode: perm, model }, () => {
          restoreDraft(project, t); setDraft(readDraft(project));
        })} />

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {open.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-neutral-500">No tasks in the last week. Start one above, or open All chats.</p>
        ) : (
          <div className="grid items-start gap-2.5 @min-[520px]:grid-cols-2 @min-[820px]:grid-cols-3">
            {shown.map((t) => <TaskCard key={t.id} t={t} busy={busy.has(t.id)} active={t.sessions.some((x) => openSids.includes(x.id))} />)}
          </div>
        )}
        {open.length > 6 && <button onClick={() => setMore((v) => !v)} className="mt-2 text-[12px] text-neutral-500 hover:text-neutral-200">{more ? "Fewer" : `${open.length - 6} more`}</button>}
      </div>
    </div>
  );
}
