"use client";
// The phone's sheets list TASKS (§37 threads), not sessions (§23 → §37, 2026-10-29).
// Thomas, on the old all-chats sheet: "this UI UX on phone is clunky, I want to view task instead of
// sessions. it requires me to navigate too much to get where I want." The sheet showed ten session rows
// ("Pace test: ok", three "Minami dashboard: …" chats) and the done-lists lived only on the desktop tile
// and board — so on the phone, "where is that task at" meant opening chats one by one.
// So, here:
// - One row per task, with its done-list bar and the next open item, readable without a tap.
// - Tapping the row opens the task's latest chat: one tap from the sheet to the work.
// - Its other chats sit behind "n chats ▾", the only thing a row folds.
// - Machine chats (Today hand-offs, Pace tests) aren't tasks; they stay one tap away on the Chats tab
//   of the same sheet, which is the old list unchanged (pins, Today fold, Older).
import ChatName from "@/components/ChatName";
import { projectLabel } from "@/lib/chat-title";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Ring, type Group } from "@/components/Inbox";
import { ProjectIcon } from "@/components/ProjectIcon";
import { ensureDod, type ThreadView } from "@/lib/use-threads";
import { DodBar } from "@/components/home/TaskCard";

const RING: Record<ThreadView["state"], Group> = { waiting: "need", working: "running", idle: "idle", queued: "idle" };
const RANK: Record<ThreadView["state"], number> = { waiting: 0, working: 1, idle: 2, queued: 3 };
const IDLE_SHOWN = 12;

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60e3);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** Open tasks worth a row: started ones (a queued card has no chat to open yet — it lives on the board). */
export function openTasks(threads: ThreadView[] | undefined, project?: string) {
  return (threads ?? []).filter((t) => t.state !== "queued" && t.sessions.length && (!project || t.project === project))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.at - a.at);
}

/** "Needs you · Working · Recent", each sorted newest first. `project` scopes it to one topic. */
export function PhoneTaskList({ threads, project, icons, titles, currentId, onOpen, empty }: {
  threads: ThreadView[];
  /** Session id → chat title, for the rows under "n chats ▾". */
  titles?: Map<string, string>;
  project?: string;
  icons: Record<string, string>;
  currentId: string | null;
  onOpen: (sid: string) => void;
  empty?: React.ReactNode;
}) {
  const [more, setMore] = useState(false);
  const all = useMemo(() => openTasks(threads, project), [threads, project]);
  const need = all.filter((t) => t.state === "waiting"), working = all.filter((t) => t.state === "working");
  const idle = all.filter((t) => t.state === "idle");
  const idleShown = more ? idle : idle.slice(0, IDLE_SHOWN);
  // The rows on screen are the ones that need a done-list; ensureDod throttles per task.
  const visible = [...need, ...working, ...idleShown];
  useEffect(() => { ensureDod(visible); }, [visible.map((t) => t.id + t.at).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const head = (text: string, tint = "text-neutral-500") => <p className={`px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.09em] ${tint}`}>{text}</p>;
  const row = (t: ThreadView) => <TaskLine key={t.id} t={t} bare={!!project} icon={icons[t.project]} titles={titles} currentId={currentId} onOpen={onOpen} />;
  if (!all.length) return <>{empty ?? <p className="px-4 py-10 text-center text-[13px] text-neutral-500">No tasks this week.</p>}</>;
  return (
    <>
      {need.length > 0 && <>{head(`Needs you · ${need.length}`, "text-[#4ade80]")}{need.map(row)}</>}
      {working.length > 0 && <>{head(`Working · ${working.length}`, "text-[#f0a868]")}{working.map(row)}</>}
      {idle.length > 0 && <>{head(`Recent · ${idle.length}`)}{idleShown.map(row)}</>}
      {idle.length > IDLE_SHOWN && (
        <button onClick={() => setMore((v) => !v)} className="flex h-11 w-full items-center px-4 text-left text-[13px] text-neutral-500 active:bg-white/5">
          {more ? "Fewer" : `${idle.length - IDLE_SHOWN} more`} ›
        </button>
      )}
    </>
  );
}

/** One task: icon + state ring, title, where it stands, then its done-list bar and the next item. */
function TaskLine({ t, bare, icon, titles, currentId, onOpen }: {
  t: ThreadView; bare: boolean; icon?: string; titles?: Map<string, string>; currentId: string | null; onOpen: (sid: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const on = !!currentId && t.sessions.some((s) => s.id === currentId);
  const dod = t.dod ?? [];
  const next = dod.find((d) => !d.done);
  const n = t.sessions.length;
  const lineTint = t.state === "waiting" ? "text-[#4ade80]" : t.state === "working" ? "italic text-[#f0a868]/90" : "text-neutral-500";
  return (
    <div data-task={t.id} className={`rounded-xl ${on ? "bg-[#2b1e23]" : ""}`}>
      <div className="flex items-start gap-2 px-3 py-2.5">
        <button onClick={() => onOpen(t.latest)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
          <span className="relative mt-0.5 shrink-0"><ProjectIcon name={t.project} icon={icon} /><Ring g={RING[t.state]} /></span>
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-[15px] ${t.state === "idle" ? "text-neutral-300" : "font-medium text-neutral-50"}`}>
              {bare ? t.title : <ChatName project={t.project} title={t.title} />}
            </span>
            {t.line && <span className={`block truncate text-[13px] ${lineTint}`}>{t.state === "waiting" ? "Needs you · " : ""}{t.line}</span>}
            {dod.length > 0 ? (
              <span className="mt-1.5 block">
                <DodBar t={t} />
                {/* What it waits on him for beats the list's next item (TaskStep, §37). */}
                {t.step ? <span className="mt-1 block truncate text-[12px] text-neutral-200"><span className="text-[var(--sakura)]">✋ </span>{t.step.q}</span>
                  : next && <span className="mt-1 block truncate text-[12px] text-neutral-400"><span className="text-neutral-600">Next · </span>{next.t}</span>}
              </span>
            ) : t.dodPending && <span className="mt-1 block text-[12px] text-neutral-600">Minami is writing the done-list…</span>}
          </span>
        </button>
        {n > 1 ? (
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`${n} chats in this task`}
            className="flex h-11 shrink-0 items-center gap-1 rounded-xl px-2 text-[12px] tabular-nums text-neutral-500 active:bg-white/10">
            {n} chats<ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        ) : <span className="shrink-0 pt-1 text-[12px] tabular-nums text-neutral-600">{ago(t.at)}</span>}
      </div>
      {open && (
        <div className="mb-1.5 ml-[52px] mr-3 border-l border-white/10">
          {[...t.sessions].reverse().map((s, i) => (
            <button key={s.id} onClick={() => onOpen(s.id)}
              className={`flex min-h-[44px] w-full items-center gap-2 pl-3 pr-1 text-left text-[13px] active:bg-white/5 ${s.id === currentId ? "text-[var(--sakura)]" : "text-neutral-400"}`}>
              <span className="min-w-0 flex-1 truncate">{titles?.get(s.id) || (i === 0 ? "Latest chat" : `Chat ${n - i}`)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Topic chips over the task list: only topics with an open task, the ones that need you first. */
export function TaskTopics({ threads, topic, setTopic }: { threads: ThreadView[]; topic: string | null; setTopic: (p: string | null) => void }) {
  const topics = useMemo(() => {
    const m = new Map<string, { n: number; need: number; at: number }>();
    for (const t of openTasks(threads)) {
      const e = m.get(t.project) ?? { n: 0, need: 0, at: 0 };
      e.n++; if (t.state === "waiting") e.need++; e.at = Math.max(e.at, t.at);
      m.set(t.project, e);
    }
    return [...m].sort((a, b) => b[1].need - a[1].need || b[1].at - a[1].at);
  }, [threads]);
  const chip = "h-10 shrink-0 rounded-full px-4 text-[14px]";
  return (
    <div className="flex gap-2 overflow-x-auto px-4 pb-1 pt-1 [scrollbar-width:none]">
      <button onClick={() => setTopic(null)} className={`${chip} ${!topic ? "bg-white/15 text-white" : "bg-white/[0.05] text-neutral-300"}`}>All</button>
      {topics.map(([p, e]) => (
        <button key={p} onClick={() => setTopic(topic === p ? null : p)} className={`${chip} ${topic === p ? "bg-white/15 text-white" : "bg-white/[0.05] text-neutral-300"}`}>
          {projectLabel(p) || p} <span className={`tabular-nums ${e.need ? "text-[#4ade80]" : "text-neutral-500"}`}>{e.need ? `· ${e.need}` : `· ${e.n}`}</span>
        </button>
      ))}
    </div>
  );
}
