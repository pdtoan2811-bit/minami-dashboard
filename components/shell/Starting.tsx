"use client";
// Tasks starting in the background (§37), shown on every page by the shell. The New task sheets close
// the moment Start is pressed (lib/ask.ts startInBackground), so this is the only sign that something
// is on its way: a spinner while the worktree and session spin up, then Open once the session id is
// known, or the error with "draft kept" if it never started. Open is a choice, never automatic — by the
// time it's ready he may be reading something else.
import { useEffect, useSyncExternalStore } from "react";
import { dismissStarting, getStarting, subscribeStarting, type Starting as S } from "@/lib/ask";
import { K, mix } from "@/app/today/ui";

const none: S[] = [];

export function Starting({ bottom }: { bottom: number }) {
  const list = useSyncExternalStore(subscribeStarting, getStarting, () => none).filter((s) => !s.hidden);
  if (!list.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 z-[70] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
      style={{ bottom: `calc(${bottom + 16}px + env(safe-area-inset-bottom))` }}>
      {list.map((s) => <Row key={s.id} s={s} />)}
    </div>
  );
}

function Row({ s }: { s: S }) {
  // A ready row goes away by itself; the task is on the board by then. A failure stays until dismissed.
  useEffect(() => {
    if (s.state !== "ready") return;
    const t = setTimeout(() => dismissStarting(s.id), 15_000);
    return () => clearTimeout(t);
  }, [s.state, s.id]);

  const open = () => {
    if (!s.sid) return;
    dismissStarting(s.id);
    // `minami:open-chat` is only heard by the board; from any other page go there the way a
    // notification link does.
    if (location.pathname === "/") window.dispatchEvent(new CustomEvent("minami:open-chat", { detail: s.sid }));
    else location.assign(`/?open=${encodeURIComponent(s.sid)}`);
  };

  const failed = s.state === "failed";
  return (
    <div className="pointer-events-auto flex items-center gap-2.5 rounded-2xl px-3.5 py-2.5 text-[13px]"
      style={{ background: mix(K.paper, 92), border: `1px solid ${failed ? "rgba(239,124,124,.45)" : K.line2}`, boxShadow: "0 12px 36px rgba(0,0,0,.45)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)" }}>
      {s.state === "starting" && <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--sakura)] border-t-transparent" />}
      {s.state === "ready" && <span className="shrink-0 text-[#4ade80]">✓</span>}
      {failed && <span className="shrink-0 text-[#ef7c7c]">!</span>}
      <div className="min-w-0 flex-1">
        <p className="truncate" style={{ color: K.ink }}>
          {s.state === "starting" ? "Starting task" : s.state === "ready" ? "Task started" : "Couldn't start"}
          <span style={{ color: K.faint }}> · {s.project}</span>
        </p>
        <p className="truncate text-[12px]" style={{ color: failed ? "#ef7c7c" : K.faint }}>
          {failed ? `${s.error} — draft kept` : s.title}
        </p>
      </div>
      {s.state === "ready" && s.sid && (
        <button onClick={open} className="shrink-0 rounded-full px-3 py-1 text-[12.5px] font-semibold text-white" style={{ background: "var(--accent-fill)" }}>Open</button>
      )}
      {s.state !== "starting" && (
        <button onClick={() => dismissStarting(s.id)} aria-label="Dismiss" className="shrink-0 px-1 text-[13px]" style={{ color: K.muted }}>✕</button>
      )}
    </div>
  );
}
