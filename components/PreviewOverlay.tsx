"use client";
// A localhost preview, full screen inside the app — the phone's answer to "open in a new tab" (§23).
//
// Opened by lib/open-local.ts on touch-only devices. Back is wired by the caller (useBackLayer): the
// framed page's own navigations sit in the same joint session history ABOVE this layer's entry, so
// Android Back first walks back through the preview's pages, then lands on ours and closes it — the
// order you'd expect from a browser, without leaving the app.
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ExternalLink, RotateCw } from "lucide-react";
import { tailnetUrl } from "@/lib/open-local";

export function PreviewOverlay({ href, onClose }: { href: string; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let live = true;
    tailnetUrl(href).then((u) => live && setSrc(u)).catch((e: Error) => live && setErr(e.message));
    return () => { live = false; };
  }, [href]);
  const label = href.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-neutral-950">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 py-1.5 pl-1.5 pr-14">
        <button onClick={onClose} aria-label="Back to the chat"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-neutral-300 active:bg-white/10"><ChevronLeft className="h-5 w-5" /></button>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-neutral-400">{label}</span>
        {/* Reload by resetting src: the frame is cross-origin, so its contentWindow can't be told to. */}
        <button onClick={() => { const f = frame.current; if (f && src) { f.src = "about:blank"; requestAnimationFrame(() => { f.src = src; }); } }} aria-label="Reload"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-neutral-400 active:bg-white/10"><RotateCw className="h-4 w-4" /></button>
        <button onClick={() => src && window.open(src, "_blank", "noopener")} disabled={!src} aria-label="Open in browser"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-neutral-400 active:bg-white/10 disabled:opacity-30"><ExternalLink className="h-4 w-4" /></button>
      </div>
      {err ? <p className="p-6 text-sm text-neutral-400">Couldn&apos;t open {label} from this device — {err}</p>
        : src ? <iframe ref={frame} src={src} title={label} className="min-h-0 w-full flex-1 border-0 bg-white" />
        : <p className="p-6 text-sm text-neutral-500">Finding {label} on the tailnet…</p>}
    </div>
  );
}
