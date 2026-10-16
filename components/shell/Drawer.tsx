"use client";
// The bell's drawer (§30): everything that needs Thomas, from any page — chats asking something, a
// goal runner's part for today, an automation that is failing — and below it the update log
// (deploys, builds) that NotificationBell used to hold in a dropdown on Bento only.
//
// A drawer and not a page: the answer to "what needs me" should be reachable without leaving what
// you are doing, and the pages each item points at already exist. The drawer only routes.
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useEvents } from "@/lib/use-events";
import { useBackLayer } from "@/lib/use-back";
import { K, mix, EASE } from "@/app/today/ui";
import type { ShellData, ShellNeed } from "@/app/api/shell/route";

const ASK: Record<string, string> = { question: "asks you", plan: "has a plan for you", permission: "wants approval", held: "is paused, waiting" };
const DOT = { success: "#6fbf8b", error: "#ef7c7c", warn: "#e0a33e", info: "#8ab4d8" } as const;

function ago(ts?: number) {
  if (!ts) return "";
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

/** Open a chat from anywhere. On Bento the board is already mounted and reads `?open=` only at mount,
 *  so it is told by event instead; anywhere else the URL does it. */
export function useOpenChat() {
  const router = useRouter(), p = usePathname();
  return (sid: string) => {
    if (p === "/") window.dispatchEvent(new CustomEvent("minami:open-chat", { detail: sid }));
    else router.push(`/?open=${encodeURIComponent(sid)}`);
  };
}

export function Drawer({ open, onClose, data }: { open: boolean; onClose: () => void; data: ShellData | null }) {
  const { events, unread, markSeen } = useEvents();
  const openChat = useOpenChat();
  const router = useRouter();
  useBackLayer(open, onClose);
  // Opening the drawer is the acknowledgement for the update log, as it was for the old bell.
  useEffect(() => { if (open && unread) markSeen(); }, [open, unread, markSeen]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [open, onClose]);

  const needs = data?.needs ?? [];
  const go = (n: ShellNeed) => {
    onClose();
    if (n.kind === "chat") openChat(n.sid);
    else router.push(n.kind === "goal" ? `/autopilot#goal-${n.id}` : "/autopilot#runners");
  };

  return (
    <div className={`fixed inset-0 z-[80] ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div onClick={onClose} className="absolute inset-0 transition-opacity duration-300" style={{ background: "rgba(0,0,0,.45)", opacity: open ? 1 : 0 }} />
      <aside role="dialog" aria-label="Needs you"
        className="absolute flex flex-col overflow-hidden max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[86dvh] max-md:rounded-t-[28px] md:bottom-3 md:right-3 md:top-3 md:w-[400px] md:rounded-[28px]"
        style={{ transition: `transform 380ms ${EASE}, opacity 300ms`, opacity: open ? 1 : 0,
          transform: open ? "none" : "var(--drawer-off, translateX(24px))",
          background: `linear-gradient(160deg, ${mix(K.paper, 92)}, ${mix(K.bg, 96)})`, border: `1px solid ${K.line2}`,
          backdropFilter: "blur(24px) saturate(170%)", WebkitBackdropFilter: "blur(24px) saturate(170%)",
          boxShadow: "0 24px 70px rgba(0,0,0,.55)" }}>
        <div className="flex items-center gap-2 px-5 pb-2 pt-5">
          <span className="text-[17px] font-semibold tracking-tight">Needs you</span>
          <span className="tabular-nums" style={{ fontFamily: "var(--today-mono)", fontSize: 11, color: K.faint }}>{needs.length}</span>
          <button onClick={onClose} className="ml-auto rounded-full px-3 py-1 text-[13px]" style={{ color: K.muted, background: mix(K.ink, 8) }}>Close</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {needs.length === 0 && <p className="px-2 py-6 text-center text-[13.5px]" style={{ color: K.muted }}>Nothing is waiting on you.</p>}
          {needs.map((n) => (
            <button key={n.kind + ((n as { sid?: string }).sid ?? (n as { id?: string }).id)} onClick={() => go(n)}
              className="mb-1.5 block w-full rounded-[18px] px-4 py-3 text-left transition-colors hover:bg-white/[0.07]"
              style={{ background: mix(K.ink, 5), border: `1px solid ${K.line}` }}>
              <div className="flex items-baseline gap-2">
                <span className="rounded-full px-1.5 py-px text-[9.5px] tracking-[0.06em]" style={{ fontFamily: "var(--today-mono)",
                  background: n.kind === "automation" ? mix(K.cat6, 30) : n.kind === "goal" ? mix(K.cat3, 30) : mix(K.accent, 30) }}>
                  {n.kind === "chat" ? "CHAT" : n.kind === "goal" ? "GOAL" : "FAILING"}</span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{n.title}</span>
                {n.kind === "chat" && <span className="shrink-0 text-[11px] tabular-nums" style={{ color: K.faint }}>{ago(n.since)}</span>}
              </div>
              <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug" style={{ color: K.muted }}>
                {n.project && <span style={{ color: K.faint }}>{n.project} · </span>}
                {n.kind === "chat" ? `${ASK[n.ask] ?? "is waiting"}: ${n.summary}` : n.summary}
              </p>
            </button>
          ))}

          <p className="px-2 pb-1.5 pt-5" style={{ fontFamily: "var(--today-mono)", fontSize: 11, letterSpacing: "0.08em", color: K.faint }}>UPDATES · DEPLOYS · BUILDS</p>
          {events.length === 0 && <p className="px-2 pb-4 text-[12.5px]" style={{ color: K.faint }}>Nothing yet.</p>}
          {events.slice(0, 30).map((e) => (
            <div key={e.id} className="px-2 py-2" style={{ borderTop: `1px solid ${K.line}` }}>
              <div className="flex items-baseline gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: DOT[e.level] || DOT.info }} />
                <span className="min-w-0 flex-1 text-[12.5px] font-medium">{e.title}</span>
                <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: K.faint }}>{ago(e.ts)}</span>
              </div>
              {/* Bodies are command output (a verify table, a tsc error): monospace, whitespace kept. */}
              {e.body && <pre className="mt-1 whitespace-pre-wrap pl-3.5 text-[10.5px] leading-[1.45]" style={{ fontFamily: "var(--today-mono)", color: K.muted }}>{e.body}</pre>}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
