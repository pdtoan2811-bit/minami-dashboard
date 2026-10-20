"use client";
// One filter row for every phone list of chats — the inbox and the all-chats sheet (§23).
//
// The first version (2026-10-20 morning) put a chip for every topic ever seen plus a four-way Today
// switch (Fold / Show / Hide / Only) on two rows above the inbox, and none on the sheet. Thomas: "all
// over the place". So, one row, and the same row in both places:
// - Topics are the ones with a chat that moved in the last 24h. Today hand-offs don't count towards
//   that: a topic whose only recent chats are Today runs isn't a topic you're working in. The rest
//   wait behind "+N older".
// - Today is one chip, not a mode switch. Off (the default) folds Today chats to one line at the bottom
//   of the list; on shows only them. "Show" and "Hide" were the same two lists with extra words.
// - A topic that needs you or failed carries a green dot, so the row says where to go next.
// - Topic and Today are the shell's settings, so narrowing the inbox narrows the sheet too.
import { useMemo, useState } from "react";
import { Sun } from "lucide-react";
import { projectLabel } from "@/lib/chat-title";
import { projectKey, useProjectFilter } from "@/lib/project-filter";
import { useSetting } from "@/lib/use-settings";

/** A topic gets a chip when one of its chats (not a Today hand-off) moved within this. */
export const RECENT_TOPIC_MS = 24 * 3600_000;

type Chat = { project: string; lastActivity: number; today?: boolean };

export function useChatFilter() {
  const [topic, setTopic] = useProjectFilter();
  const [todayOnly, setTodayOnly] = useSetting<boolean>("chatsTodayOnly", false);
  // Exact topic match here, where the shell's other pages match by prefix (lib/project-filter): there,
  // "ecvision" keeping "ecvisionContent" is sibling work worth seeing; in a list of chats it put another
  // topic's twelve chats in the list you had just narrowed.
  const keep = (s: Chat) => (!topic || projectKey(s.project) === projectKey(topic)) && (!todayOnly || !!s.today);
  return { topic, setTopic, todayOnly, setTodayOnly, keep };
}

export function ChatFilter({ chats, topic, setTopic, todayOnly, setTodayOnly, loud, className = "" }: {
  chats: Chat[];
  topic: string;
  setTopic: (v: string) => void;
  todayOnly: boolean;
  setTodayOnly: (v: boolean) => void;
  /** Topics with a chat that needs you or failed. */
  loud?: Set<string>;
  className?: string;
}) {
  const [more, setMore] = useState(false);
  const { recent, older, todayN } = useMemo(() => {
    const now = Date.now();
    const last = new Map<string, number>();
    const all = new Set<string>();
    let todayN = 0;
    for (const s of chats) {
      if (s.today) todayN++;
      // In Today-only the chips are the topics the Today chats are in; otherwise Today chats don't count.
      if (todayOnly ? !s.today : s.today) continue;
      all.add(s.project);
      if (todayOnly || now - s.lastActivity < RECENT_TOPIC_MS) last.set(s.project, Math.max(last.get(s.project) || 0, s.lastActivity));
    }
    return {
      recent: [...last].sort((a, b) => b[1] - a[1]).map(([p]) => p),
      older: [...all].filter((p) => !last.has(p)).sort((a, b) => a.localeCompare(b)),
      todayN,
    };
  }, [chats, todayOnly]);
  const on = (p: string) => !!topic && projectKey(p) === projectKey(topic);
  // A topic picked elsewhere (the shell picker, or from "older") stays visible so it can be cleared.
  const stray = topic && !recent.some(on) && !(more && older.some(on)) ? (older.find(on) ?? topic) : "";
  const chip = (sel: boolean) => `flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] ${sel ? "bg-white/[0.14] text-neutral-50" : "bg-white/[0.04] text-neutral-400 active:bg-white/[0.08]"}`;
  const topicChip = (p: string) => (
    <button key={p} className={chip(on(p))} onClick={() => setTopic(on(p) ? "" : p)}>
      {loud?.has(p) && <span className="h-1.5 w-1.5 rounded-full bg-[#4ade80]" aria-label="needs you" />}
      {projectLabel(p)}{on(p) && <span className="text-neutral-500">✕</span>}
    </button>
  );
  return (
    <div className={`flex gap-1.5 [scrollbar-width:none] ${more ? "flex-wrap" : "overflow-x-auto"} ${className}`}>
      <button className={chip(!topic && !todayOnly)} onClick={() => { setTopic(""); setTodayOnly(false); }}>All</button>
      {todayN > 0 && (
        <button className={chip(todayOnly)} onClick={() => setTodayOnly(!todayOnly)} aria-pressed={todayOnly}>
          <Sun className="h-3.5 w-3.5" />Today · {todayN}
        </button>
      )}
      <span className="my-1.5 w-px shrink-0 bg-white/10" />
      {stray && topicChip(stray)}
      {recent.map(topicChip)}
      {more ? older.filter((p) => p !== stray).map(topicChip) : older.length > 0 && (
        <button className={chip(false)} onClick={() => setMore(true)}>+{older.length} older</button>
      )}
      {more && <button className={chip(false)} onClick={() => setMore(false)}>Less</button>}
    </div>
  );
}
