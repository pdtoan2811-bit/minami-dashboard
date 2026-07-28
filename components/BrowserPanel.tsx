"use client";
// Docked next to a chat pane once it's used the browser tool (Playwright MCP — see manager.ts). Not
// true continuous video: it shows the latest screenshot the agent has taken, swapped in the instant a
// browser_* tool call returns one. For a QA-testing workflow (navigate, click, screenshot, compare)
// this reads as "live" in practice — sub-second after every action — without the much bigger lift of a
// real CDP screencast. See README's "Browser tool" section for the tradeoff.
import { Chrome } from "lucide-react";

export type BrowserShot = { mediaType: string; data: string; action?: string } | null;

export default function BrowserPanel({ shot, busy, actionLabel, onClose }: {
  shot: BrowserShot; busy: boolean; actionLabel?: string; onClose: () => void;
}) {
  const dataUri = shot ? `data:${shot.mediaType};base64,${shot.data}` : null;
  return (
    <div className="flex w-[300px] shrink-0 flex-col border-l border-white/10 bg-black/20">
      <div className="flex items-center gap-1.5 border-b border-white/[0.07] px-3 py-2">
        <Chrome className="h-3.5 w-3.5 text-[#5ec8f8]" strokeWidth={2.25} />
        <span className="text-[11px] font-semibold text-neutral-300">Browser</span>
        {busy && <span className="think-dot h-1.5 w-1.5 rounded-full" style={{ background: "#5ec8f8" }} />}
        <button onClick={onClose} title="Hide panel" className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-neutral-500 transition-colors hover:bg-white/10">✕</button>
      </div>
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2"
        style={{ backgroundImage: "repeating-conic-gradient(rgba(255,255,255,0.03) 0% 25%, transparent 0% 50%)", backgroundSize: "16px 16px" }}
      >
        {dataUri ? (
          <a href={dataUri} target="_blank" rel="noreferrer" title="Open full size" className="flex max-h-full max-w-full items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={dataUri} alt="" className="max-h-full max-w-full rounded border border-white/10 object-contain shadow-lg" />
          </a>
        ) : (
          <p className="px-4 text-center text-[11px] leading-relaxed text-neutral-600">
            {busy ? "waiting for a screenshot…" : "no screenshot yet — ask Claude to take one"}
          </p>
        )}
      </div>
      {actionLabel && (
        <div className="truncate border-t border-white/[0.07] px-3 py-1.5 text-[10px] text-neutral-500">{actionLabel}</div>
      )}
    </div>
  );
}
