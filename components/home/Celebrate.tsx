"use client";
// A task that finished itself gets a moment (§37). When the last done-item is ticked — by Minami reading
// the chat, or by him — the server archives the task to Done on its own (`autoDone`). Thomas,
// 2026-10-28: "task with signal that it's done will have a congrats animation and mark done which go to
// archive… I don't want to check the subtask done manually". So the page says so once, with the way back
// (Reopen) in the same breath, because Minami's reading of "done" can be wrong.
//
// Once per task per browser (localStorage), and only for tasks closed in the last 15 minutes, so opening
// the dashboard in the morning doesn't replay yesterday's. One burst, then still: a finished animation
// costs nothing (the page's no-standing-animation rule, §5).
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { openThread, threadPost, useThreads, type ThreadView } from "@/lib/use-threads";

const KEY = "minami.celebrated";
const WINDOW_MS = 15 * 60e3;
const seen = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
const remember = (id: string) => { try { localStorage.setItem(KEY, JSON.stringify([...seen(), id].slice(-200))); } catch { /* private mode */ } };
const COLORS = ["#4ade80", "#e8859b", "#f0a868", "#6c9cf5", "#fde68a"];

function Burst() {
  const bits = useMemo(() => Array.from({ length: 34 }, (_, i) => ({
    x: (Math.random() - 0.5) * 520, y: -120 - Math.random() * 260, r: Math.random() * 540 - 270,
    c: COLORS[i % COLORS.length], w: 5 + Math.random() * 5, d: Math.random() * 0.15,
  })), []);
  return (
    <div className="pointer-events-none absolute bottom-6 left-1/2 h-0 w-0">
      {bits.map((b, i) => (
        <motion.span key={i} className="absolute block rounded-[2px]" style={{ width: b.w, height: b.w * 0.45, background: b.c }}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
          animate={{ x: b.x, y: [0, b.y, b.y + 220], opacity: [1, 1, 0], rotate: b.r }}
          transition={{ duration: 1.6, delay: b.d, ease: "easeOut", times: [0, 0.45, 1] }} />
      ))}
    </div>
  );
}

export function Celebrate() {
  const d = useThreads();
  const reduce = useReducedMotion();
  const [now, setNow] = useState<ThreadView | null>(null);
  useEffect(() => {
    if (now || !d) return;
    const done = seen();
    const t = d.done.find((x) => x.autoDone && (x.doneAt ?? 0) > Date.now() - WINDOW_MS && !done.includes(x.id));
    if (t) { remember(t.id); setNow(t); }
  }, [d, now]);
  useEffect(() => { if (!now) return; const x = setTimeout(() => setNow(null), 7000); return () => clearTimeout(x); }, [now]);

  return (
    <AnimatePresence>
      {now && (
        // Above the phone's tab bar, not on it: at a flat bottom-24 it sat over ＋ Task for its 7 seconds,
        // and a tap there hit the toast instead. The desk's `bottom-8` is for a mouse only — `md:` alone
        // also matched the unfolded N5 (813px), and dropped it back onto the tabs.
        <motion.div key={now.id} className="fixed inset-x-0 bottom-[calc(var(--shell-bottom,0px)+1rem)] z-[60] flex justify-center px-4 md:pointer-fine:bottom-8"
          initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12 }}
          transition={{ type: "spring", stiffness: 340, damping: 26 }}>
          {!reduce && <Burst />}
          <div role="status" className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-[#4ade80]/40 bg-neutral-900/95 px-4 py-3 shadow-[0_20px_60px_-20px_rgba(74,222,128,0.5)]">
            <motion.span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#4ade80]/15 text-lg text-[#4ade80]"
              initial={{ scale: 0.4, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 420, damping: 14, delay: 0.1 }}>✓</motion.span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold text-neutral-100">Done — nice.</span>
              <span className="block truncate text-[12px] text-neutral-400">{now.title}</span>
              <span className="block truncate text-[11px] text-neutral-500">{now.closedWhy ? (now.closedWhy === "closed from the chat" ? "Closed from the chat" : `“${now.closedWhy}”`) : "Every done-item met"} · moved to Done</span>
            </span>
            <span className="flex shrink-0 flex-col gap-1">
              {now.sessions.length > 0 && <button onClick={() => { openThread(now); setNow(null); }} className="rounded-md border border-white/12 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-white/30">Open</button>}
              <button onClick={() => { void threadPost({ action: "unarchive", id: now.id }); setNow(null); }} className="rounded-md border border-white/12 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-white/30">Reopen</button>
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
