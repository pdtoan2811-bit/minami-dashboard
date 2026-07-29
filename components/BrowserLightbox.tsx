"use client";
// Full-screen viewer for browser screenshots — the thing that was missing entirely.
//
// The old "open full size" affordance was `<a href="data:image/png;base64,…" target="_blank">`, in both
// the panel and the transcript thumbnails. **Chrome has blocked top-level navigation to `data:` URLs
// since v60**, so that click silently did nothing and always had. This replaces it with a real viewer.
//
// Escape handling is the subtle part. app/page.tsx registers a window-level keydown where `Escape`
// closes the whole session panel, and it checks Escape BEFORE its input/textarea guard — so a naive
// modal would close itself and the chat pane behind it in one keypress. Listening in the CAPTURE phase
// (and stopping propagation) means this handler wins the race regardless of listener registration order.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, ExternalLink, Maximize2, Minus, Plus, X } from "lucide-react";
import type { Shot } from "@/lib/browser-view";

export type LightboxShot = Pick<Shot, "mediaType" | "data" | "file" | "url" | "title" | "action"> & { at?: number };

export const fileSrc = (file: string, cwd: string) =>
  `/api/agent/browser/file?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`;

/**
 * Where to load a shot's pixels from. The two sources are not interchangeable and the right default
 * depends on the surface:
 *
 *   • `data` — the inline base64. Instant (already in memory), but downscaled by Playwright before it
 *     was ever encoded, and dropped from sessionStorage by `trimOutput`, so it's absent after a reload.
 *   • `file` — `<cwd>/.playwright-mcp/<name>`, served by /api/agent/browser/file. Full resolution and
 *     survives a reload, but costs a request and is genuinely often missing: the agent may have run in
 *     a different cwd, or the directory may have been cleaned.
 *
 * So: thumbnails and the docked viewport pass `preferFile: false` (never wait on the network for a
 * 72px thumb), the lightbox passes `true` (resolution is the whole point of opening it). Both callers
 * must still handle `onError` — "the file is gone" is a normal state, not an exception.
 */
export function shotSrc(shot: LightboxShot, cwd?: string, preferFile = true): string | null {
  const file = shot.file && cwd ? fileSrc(shot.file, cwd) : null;
  const inline = shot.data ? `data:${shot.mediaType};base64,${shot.data}` : null;
  return preferFile ? file || inline : inline || file;
}

const ZOOMS = [1, 1.5, 2, 3];

export default function BrowserLightbox({ shots, index, cwd, onIndex, onClose }: {
  shots: LightboxShot[];
  index: number;
  cwd?: string;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const shot = shots[index];
  const [zoom, setZoom] = useState(0); // index into ZOOMS; 0 === fit-to-screen
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  // If the file 404s (different cwd, cleaned directory) fall back to the inline base64 rather than
  // showing a broken image.
  const [fileFailed, setFileFailed] = useState(false);
  // `document` doesn't exist during the server render of this client component, and the portal target
  // has to be read at render time — so wait for mount before portalling.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const step = useCallback((d: number) => {
    if (shots.length < 2) return;
    onIndex((index + d + shots.length) % shots.length);
    setZoom(0); setPan({ x: 0, y: 0 }); setFileFailed(false);
  }, [index, shots.length, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Must beat app/page.tsx's window handler, which would otherwise also close the chat pane.
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        onClose(); return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); step(1); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); step(-1); }
      else if (e.key === "+" || e.key === "=") { e.stopPropagation(); setZoom((z) => Math.min(ZOOMS.length - 1, z + 1)); }
      else if (e.key === "-") { e.stopPropagation(); setZoom((z) => Math.max(0, z - 1)); }
      else if (e.key === "0") { e.stopPropagation(); setZoom(0); setPan({ x: 0, y: 0 }); }
    };
    window.addEventListener("keydown", onKey, true); // capture — see the note at the top of this file
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step, onClose]);

  if (!shot || !mounted) return null;
  const src = fileFailed && shot.data ? `data:${shot.mediaType};base64,${shot.data}` : shotSrc(shot, cwd);
  const scale = ZOOMS[zoom];
  const zoomed = zoom > 0;

  // Portalled to <body> deliberately. `position: fixed` is NOT viewport-relative when any ancestor
  // establishes a containing block — a `transform`, `filter`, `backdrop-filter` or `will-change` is
  // enough. The chat panel this renders from sits inside a `backdrop-blur` wrapper, so an in-place
  // `fixed inset-0` covered only that panel's box instead of the window: the "full screen" viewer
  // opened at about half width. Escaping to body is the only reliable fix.
  return createPortal((
    <div className="fixed inset-0 z-[90] flex flex-col bg-black/85 backdrop-blur-sm" onClick={onClose}>
      {/* Header — page identity first: which URL this pixel state belongs to is the whole point. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-neutral-100">{shot.title || shot.action}</p>
          <p className="truncate text-[11px] text-neutral-500">
            {shot.url || "no page recorded"}
            <span className="text-neutral-600"> · {shot.action}</span>
            {shot.at ? <span className="text-neutral-600"> · {new Date(shot.at).toLocaleTimeString()}</span> : null}
          </p>
        </div>
        {shots.length > 1 && (
          <span className="shrink-0 tabular-nums text-[11px] text-neutral-500">{index + 1} / {shots.length}</span>
        )}
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-white/10 p-0.5">
          <IconBtn title="Zoom out (−)" onClick={() => setZoom((z) => Math.max(0, z - 1))} disabled={zoom === 0}><Minus className="h-3.5 w-3.5" /></IconBtn>
          <button onClick={() => { setZoom(0); setPan({ x: 0, y: 0 }); }} title="Fit to screen (0)"
            className="min-w-[3rem] rounded px-1.5 py-1 text-[11px] tabular-nums text-neutral-400 transition-colors hover:bg-white/10">
            {zoomed ? `${scale}×` : "fit"}
          </button>
          <IconBtn title="Zoom in (+)" onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} disabled={zoom === ZOOMS.length - 1}><Plus className="h-3.5 w-3.5" /></IconBtn>
        </div>
        {shot.url && (
          <IconBtn title="Open this URL in your browser" onClick={() => window.open(shot.url, "_blank", "noreferrer")}><ExternalLink className="h-3.5 w-3.5" /></IconBtn>
        )}
        {src && (
          <a href={src} download={shot.file || "screenshot.png"} title="Download PNG"
            className="rounded-md px-1.5 py-1 text-neutral-500 transition-colors hover:bg-white/10 hover:text-neutral-200">
            <Download className="h-3.5 w-3.5" />
          </a>
        )}
        <IconBtn title="Close (Esc)" onClick={onClose}><X className="h-4 w-4" /></IconBtn>
      </div>

      {/* Stage */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        {shots.length > 1 && <Arrow side="left" onClick={(e) => { e.stopPropagation(); step(-1); }} />}
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src} alt={shot.action}
            onClick={(e) => { e.stopPropagation(); setZoom((z) => (z === 0 ? 1 : 0)); setPan({ x: 0, y: 0 }); }}
            onError={() => { if (!fileFailed) setFileFailed(true); }}
            onMouseDown={(e) => { if (!zoomed) return; e.preventDefault(); drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; }}
            onMouseMove={(e) => { const d = drag.current; if (!d) return; setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) }); }}
            onMouseUp={() => { drag.current = null; }}
            onMouseLeave={() => { drag.current = null; }}
            style={{
              transform: `translate(${zoomed ? pan.x : 0}px, ${zoomed ? pan.y : 0}px) scale(${scale})`,
              transformOrigin: "center",
              cursor: zoomed ? (drag.current ? "grabbing" : "grab") : "zoom-in",
              maxWidth: zoomed ? "none" : "100%",
              maxHeight: zoomed ? "none" : "100%",
            }}
            className="select-none rounded border border-white/10 shadow-2xl transition-transform duration-150 ease-out"
            draggable={false}
          />
        ) : (
          <div className="text-center text-[12px] text-neutral-500" onClick={(e) => e.stopPropagation()}>
            <Maximize2 className="mx-auto mb-2 h-5 w-5 opacity-40" />
            <p>This screenshot&apos;s pixels aren&apos;t available.</p>
            <p className="mt-1 text-neutral-600">Inline images are dropped on reload; the file on disk is gone too.</p>
          </div>
        )}
        {shots.length > 1 && <Arrow side="right" onClick={(e) => { e.stopPropagation(); step(1); }} />}
      </div>

      {/* Filmstrip — the timeline of everything the browser has shown, so a QA pass is reviewable
          after the fact rather than only in the moment. */}
      {shots.length > 1 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-white/10 px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
          {shots.map((s, i) => {
            const thumb = shotSrc(s, cwd, false);
            return (
              <button key={i} onClick={() => { onIndex(i); setZoom(0); setPan({ x: 0, y: 0 }); setFileFailed(false); }}
                title={`${s.action}${s.url ? ` — ${s.url}` : ""}`}
                className={`shrink-0 overflow-hidden rounded border transition-colors ${i === index ? "border-[#5ec8f8]" : "border-white/10 hover:border-white/30"}`}>
                {thumb
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={thumb} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} className="h-12 w-auto max-w-[120px] object-cover" />
                  : <span className="flex h-12 w-16 items-center justify-center text-[9px] text-neutral-600">no image</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  ), document.body);
}

function IconBtn({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      className="rounded-md px-1.5 py-1 text-neutral-500 transition-colors hover:bg-white/10 hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent">
      {children}
    </button>
  );
}

function Arrow({ side, onClick }: { side: "left" | "right"; onClick: (e: React.MouseEvent) => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button onClick={onClick} title={side === "left" ? "Previous (←)" : "Next (→)"}
      className={`absolute ${side === "left" ? "left-2" : "right-2"} z-10 rounded-full border border-white/10 bg-black/50 p-2 text-neutral-300 transition-colors hover:bg-black/80 hover:text-white`}>
      <Icon className="h-5 w-5" />
    </button>
  );
}
