"use client";
// The bell in the header: unread count, and a dropdown holding the last 50 alerts with their real
// bodies — the verify table from a deploy, the error line from a failed build.
//
// This exists because the pre-existing alert path (lib/use-notify.ts) is fire-and-forget by design:
// it suppresses itself when the tab is focused and leaves nothing behind. That is right for "your
// turn finished" and wrong for "the deploy you launched twenty minutes ago failed verification" —
// the second one has content you need to *read*, possibly after the toast has long since gone.
// So: the toast stays a toast, and this is the record.
import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useEvents, type EventLevel } from "@/lib/use-events";

const DOT: Record<EventLevel, string> = {
  success: "#6fbf8b",
  error: "#ef7c7c",
  warn: "#e0a33e",
  info: "#8ab4d8",
};

function ago(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function NotificationBell() {
  const { events, unread, markSeen } = useEvents();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Opening the panel is the acknowledgement — there is no separate "mark read" to forget to press.
  useEffect(() => { if (open) markSeen(); }, [open, markSeen]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={unread ? `${unread} new update${unread === 1 ? "" : "s"}` : "Updates"}
        className={`relative rounded-lg border px-2 py-1 text-xs leading-none transition-colors ${
          unread ? "border-[var(--sakura)]/40 text-[var(--sakura)]" : "border-white/10 text-neutral-500 hover:border-white/25 hover:text-neutral-200"
        }`}
      >
        <Bell className="h-3.5 w-3.5" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 min-w-[15px] rounded-full bg-[var(--sakura)] px-1 text-[9px] font-semibold leading-[15px] text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1.5 max-h-[70vh] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-white/10 bg-neutral-900/95 shadow-xl backdrop-blur">
          <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-2">
            <span className="text-[11px] font-semibold text-neutral-300">Updates</span>
            <span className="text-[10px] text-neutral-600">deploys · builds · worktrees</span>
          </div>
          {events.length === 0 ? (
            <p className="px-3 py-6 text-center text-[11px] text-neutral-600">
              Nothing yet. Deploys and worktree builds report here.
            </p>
          ) : (
            events.map((e) => (
              <div key={e.id} className="border-b border-white/[0.05] px-3 py-2 last:border-b-0">
                <div className="flex items-baseline gap-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: DOT[e.level] || DOT.info }} />
                  <span className="min-w-0 flex-1 text-[12px] font-medium text-neutral-200">{e.title}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-neutral-600">{ago(e.ts)}</span>
                </div>
                {/* Bodies are command output — a verify table, a tsc error. Monospace and preserved
                    whitespace, because reflowing them destroys the only thing they're good for. */}
                {e.body && (
                  <pre className="mt-1 whitespace-pre-wrap pl-3.5 font-mono text-[10.5px] leading-[1.45] text-neutral-500">
                    {e.body}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
