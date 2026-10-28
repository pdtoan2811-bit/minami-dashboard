"use client";
// Two one-line nudges above a chat's composer (§37), both ignorable at no cost:
//   · the draft names ANOTHER project → "Send to X instead" (Enter still sends here: Thomas's pick,
//     2026-10-28 — a message stays where he typed it unless he moves it);
//   · a long chat that isn't a named thread yet → "Name this thread?", once. Naming is what makes it
//     findable tomorrow, and Minami then suggests a done-list he can accept with one tap.
import { useEffect, useState } from "react";
import { Dod } from "./TaskCard";
import { guessProject, startAsk } from "@/lib/ask";
import { useSetting } from "@/lib/use-settings";
import { ensureDod, threadPost, useThreads } from "@/lib/use-threads";
import type { AgentMode } from "@/lib/use-agent";

const NAME_AFTER_ASKS = 6;

export function ChatHints({ sessionId, project, input, clearInput, title }: {
  sessionId: string; project: string; input: string; clearInput: () => void; title: string;
}) {
  const d = useThreads();
  const [perm] = useSetting<Exclude<AgentMode, "plan">>("permMode", "bypassPermissions");
  const [model] = useSetting<string | null>("chatModel", null);
  const [name, setName] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const task = sessionId && d ? [...d.threads, ...d.done].find((t) => t.sessions.some((x) => x.id === sessionId)) : undefined;
  useEffect(() => { if (task) ensureDod([task]); }, [task?.id, task?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;

  const other = input.trim().length > 12 ? guessProject(input, d.projects) : null;
  const elsewhere = other && other.project !== project ? other : null;

  const thread = sessionId ? d.threads.find((t) => t.sessions.some((x) => x.id === sessionId)) : undefined;
  const offer = !gone && !!thread && !thread.stored && thread.asks >= NAME_AFTER_ASKS && !d.dismissed.includes(sessionId);

  // Which task this chat is, how far along, and what's next — so the done-list is in view while he
  // chats, not one tap away on the board (Thomas, 2026-10-28: "indicate which task I am chatting with").
  const strip = task && (task.dod?.length || task.stored) ? (
    <div className="mx-1 mb-1 rounded-xl border border-white/[0.08] bg-white/[0.025] px-2.5 py-1.5">
      <button onClick={() => setTaskOpen((v) => !v)} className="flex w-full items-center gap-2 text-left" title={taskOpen ? "Fold" : "Show the whole done-list"}>
        <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.1em] text-neutral-500">Task</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-neutral-200">{task.title}</span>
        {task.archived && <span className="shrink-0 text-[11px] text-[#4ade80]">done ✓</span>}
        {!task.archived && (
          <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); void threadPost({ action: "archive", id: task.id }); }}
            className="shrink-0 rounded-md border border-white/12 px-1.5 py-px text-[10px] text-neutral-400 hover:border-[#4ade80]/50 hover:text-[#4ade80]" title="Mark this task done">✓ Done</span>
        )}
        <span className="shrink-0 text-[11px] text-neutral-600">{taskOpen ? "▾" : "▸"}</span>
      </button>
      <div className="mt-1"><Dod key={taskOpen ? "open" : "fold"} t={task} busy={(d.busy ?? []).includes(task.id)} fold={!taskOpen} /></div>
    </div>
  ) : null;

  if (!elsewhere && !offer) return strip;
  const pill = "shrink-0 rounded-lg border border-white/12 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-white/30 pointer-coarse:py-1.5";
  return (
    <>
    {strip}
    <div className="flex flex-col gap-1 px-1 pb-1 text-[12px] text-neutral-400">
      {elsewhere && (
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate">This mentions <span className="text-neutral-200">{elsewhere.project}</span>.</span>
          <button className={pill} onClick={() => { const t = input.trim(); clearInput(); void startAsk(elsewhere, t, { mode: perm, model }); }}>Send there instead</button>
        </div>
      )}
      {offer && (
        name === null ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate">Long chat — name it so it's easy to pick up tomorrow?</span>
            <button className={pill} onClick={() => setName(thread!.title || title)}>Name it</button>
            <button className="shrink-0 px-1 text-neutral-600 hover:text-neutral-300" title="Don't ask again for this chat" onClick={() => { setGone(true); void threadPost({ action: "dismiss", sessionId }); }}>✕</button>
          </div>
        ) : (
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); setGone(true); void threadPost({ action: "name", sessionId, title: name }); }}>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-white/12 bg-transparent px-2 py-1 text-[16px] text-neutral-100 outline-none md:text-[12px]" />
            <button className={pill} type="submit">Save</button>
          </form>
        )
      )}
    </div>
    </>
  );
}
