"use client";
// The browser window for a headless browser.
//
// Bento hands every live chat a headless, isolated Playwright MCP browser (see manager.ts). Claude
// Code's own browser integration drives your *real, visible* Chrome instead — which is why it ships no
// viewport UI at all: its entire surface is a status panel, a per-domain permission gate, and an
// activity log, because the live view is simply your Chrome window. A headless browser has no window,
// so this panel has to BE the window. That's the whole design brief: not a copy of Claude Code's UI,
// the headless analogue of it.
//
// Everything here is derived from tool results that already flow over SSE (see lib/browser-view.ts) —
// no server-side handle on the browser exists. The consequence worth knowing: the toolbar's controls
// can't drive the browser directly, so they **drive the agent** instead, by sending it a message. That
// isn't a workaround; it's exactly Claude Code's model, where navigation is a tool call rather than a
// chrome affordance.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Camera, Chrome, Circle, ExternalLink, Globe, Monitor, PanelRightClose,
  RefreshCw, Smartphone, Square, Tablet, Terminal, ArrowLeft, ArrowRight, Copy, Check, Radio,
} from "lucide-react";
import type { BrowserState, Shot } from "@/lib/browser-view";
import { shotSrc } from "./BrowserLightbox";

const TINT = "#5ec8f8"; // TOOL_TINT.browser — keep in sync with app/page.tsx

/** Device presets for the "design verification" workflow. Claude Code has raw width/height only (no
 *  presets); Playwright MCP's `browser_resize` lets us do better, so this is a deliberate improvement
 *  rather than parity. Sizes are CSS-pixel viewports, matching what `--viewport-size` expects. */
const DEVICES: { label: string; w: number; h: number; Icon: typeof Monitor }[] = [
  { label: "Desktop", w: 1280, h: 800, Icon: Monitor },
  { label: "Laptop", w: 1440, h: 900, Icon: Monitor },
  { label: "iPad", w: 820, h: 1180, Icon: Tablet },
  { label: "iPhone", w: 390, h: 844, Icon: Smartphone },
];

type Tab = "console" | "network" | "actions";

export default function BrowserPanel({
  state, busy, actionLabel, cwd, live, stacked, onOpenShot, onAsk, onClose, onToggleLayout, onPopOut,
}: {
  state: BrowserState;
  busy: boolean;
  actionLabel?: string;
  /** Session cwd — needed to fetch full-resolution artifacts from `<cwd>/.playwright-mcp/`. */
  cwd?: string;
  /** A live agent session exists, so the toolbar can actually ask it to do things. */
  live: boolean;
  stacked: boolean;
  onOpenShot: (i: number) => void;
  /** Send a message to the agent. Every toolbar control routes through this. */
  onAsk: (prompt: string) => void;
  /** Omitted in the pop-out window, where there's no panel to hide and no sibling layout to flip. */
  onClose?: () => void;
  onToggleLayout?: () => void;
  onPopOut?: () => void;
}) {
  const { shots, url, title, viewport, consoleErrors, consoleWarnings, network, actions, recording, staleBy, httpStatus, crashed } = state;
  // `pinned === null` means "follow the newest shot", which is what you want while watching a QA run.
  const [pinned, setPinned] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const strip = useRef<HTMLDivElement>(null);

  const shownIdx = pinned ?? shots.length - 1;
  const shot: Shot | undefined = shots[shownIdx];
  const following = pinned === null;

  // Keep the filmstrip pinned to the newest thumbnail while following, so a long QA run doesn't
  // silently scroll its own progress out of view.
  useEffect(() => {
    if (following && strip.current) strip.current.scrollLeft = strip.current.scrollWidth;
  }, [shots.length, following]);

  const errCount = consoleErrors + (crashed ? 1 : 0);
  const problem = errCount > 0 || (httpStatus !== undefined && httpStatus >= 400);
  // Prefer the inline base64 here: it's already in memory, and this view is scaled down anyway — the
  // full-resolution file is what the lightbox is for. `dead` tracks shots whose only available source
  // 404'd (a reload with no `.playwright-mcp` left on disk), so we render the honest empty state
  // instead of a broken-image icon with alt text sitting where the page should be.
  const [dead, setDead] = useState<Record<string, boolean>>({});
  const src = shot && !dead[shot.id] ? shotSrc(shot, cwd, false) : null;
  const consoleBody = useMemo(() => state.consoleLines.filter((l) => tab === "console"), [state.consoleLines, tab]);

  const ask = (p: string) => { if (live) onAsk(p); };

  return (
    <div className={stacked
      ? "flex min-h-0 shrink-0 flex-col border-t border-white/10 bg-black/20"
      : "flex min-h-0 flex-1 flex-col border-l border-white/10 bg-black/20"}>

      {/* ── Zone 1: chrome toolbar. Every control sends the agent a message. ───────────────────── */}
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.07] px-2 py-1.5">
        <Nav title="Back" onClick={() => ask("Go back in the browser, then take a screenshot.")} disabled={!live}><ArrowLeft className="h-3.5 w-3.5" /></Nav>
        <Nav title="Forward" onClick={() => ask("Go forward in the browser, then take a screenshot.")} disabled={!live}><ArrowRight className="h-3.5 w-3.5" /></Nav>
        <Nav title="Reload" onClick={() => ask("Reload the current page in the browser, then take a screenshot.")} disabled={!live || !url}>
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
        </Nav>

        {/* URL bar — editable. Enter asks the agent to navigate. */}
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-white/10 bg-black/40 px-1.5 py-0.5 focus-within:border-[#5ec8f8]/50">
          <Globe className="h-3 w-3 shrink-0 text-neutral-600" />
          {editingUrl ? (
            <input
              autoFocus value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={() => setEditingUrl(false)}
              onKeyDown={(e) => {
                e.stopPropagation(); // the page-level handler treats Escape as "close the chat pane"
                if (e.key === "Enter" && urlDraft.trim()) {
                  ask(`Navigate the browser to ${urlDraft.trim()} and take a screenshot.`);
                  setEditingUrl(false);
                } else if (e.key === "Escape") setEditingUrl(false);
              }}
              placeholder="localhost:3000"
              className="min-w-0 flex-1 bg-transparent text-[11px] text-neutral-200 outline-none placeholder:text-neutral-600"
            />
          ) : (
            <button
              onClick={() => { setUrlDraft(url || ""); setEditingUrl(true); }}
              disabled={!live}
              title={live ? (url ? `${url} — click to edit and navigate` : "Click to enter a URL") : url || ""}
              className="min-w-0 flex-1 truncate text-left text-[11px] text-neutral-300 disabled:cursor-default">
              {url ? url.replace(/^https?:\/\//, "") : <span className="text-neutral-600">no page yet</span>}
            </button>
          )}
          {httpStatus !== undefined && httpStatus >= 400 && (
            <span className="shrink-0 rounded px-1 text-[9px] font-semibold text-[#ef7c7c]">{httpStatus}</span>
          )}
          {url && (
            <>
              <button title={copied ? "Copied" : "Copy URL"}
                onClick={() => { navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}
                className="shrink-0 text-neutral-600 transition-colors hover:text-neutral-300">
                {copied ? <Check className="h-3 w-3 text-[#4ade80]" /> : <Copy className="h-3 w-3" />}
              </button>
              {/* Opening it for real is the single most useful thing here when it's a localhost dev server. */}
              <button title="Open in your own browser" onClick={() => window.open(url, "_blank", "noreferrer")}
                className="shrink-0 text-neutral-600 transition-colors hover:text-neutral-300">
                <ExternalLink className="h-3 w-3" />
              </button>
            </>
          )}
        </div>

        {/* Console-error badge. Front and center because "live debugging" — read the console, fix the
            code that caused it — is the primary documented use case for a browser in a coding agent. */}
        <button
          onClick={() => { setTab(tab === "console" ? null : "console"); if (live && !state.consoleLines.length && errCount) onAsk("Read the browser console messages (errors only) and tell me what's failing."); }}
          title={problem ? `${errCount} console error${errCount === 1 ? "" : "s"}` : "Console"}
          className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] tabular-nums transition-colors ${problem
            ? "bg-[#ef7c7c]/15 text-[#ef7c7c] hover:bg-[#ef7c7c]/25"
            : "text-neutral-600 hover:bg-white/10 hover:text-neutral-300"}`}>
          {problem ? <AlertTriangle className="h-3 w-3" /> : <Terminal className="h-3 w-3" />}
          {errCount > 0 && errCount}
          {consoleWarnings > 0 && <span className="text-[#f0a868]">{consoleWarnings}</span>}
        </button>

        {onClose && <Nav title="Hide the browser panel" onClick={onClose}><PanelRightClose className="h-3.5 w-3.5" /></Nav>}
      </div>

      {/* ── Zone 1b: status strip — the analogue of Claude Code's Status/Extension/Browser triad. ── */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-white/[0.07] px-2 py-1 text-[10px] text-neutral-600">
        <Chrome className="h-3 w-3 shrink-0" style={{ color: TINT }} strokeWidth={2.25} />
        <span className="shrink-0" title="Each chat gets its own in-memory browser profile — no cookies, nothing on disk, nothing shared between chats">
          headless · isolated
        </span>
        {viewport && (
          <button onClick={() => setDeviceOpen((v) => !v)} disabled={!live}
            title={live ? "Ask Claude to resize the viewport" : `Viewport ${viewport}`}
            className={`shrink-0 rounded px-1 py-0.5 tabular-nums transition-colors hover:bg-white/10 hover:text-neutral-300 disabled:hover:bg-transparent ${deviceOpen ? "bg-white/10 text-neutral-300" : ""}`}>
            {viewport}
          </button>
        )}
        {state.tabCount !== undefined && state.tabCount > 1 && (
          <span className="shrink-0" title={`${state.tabCount} open tabs`}>{state.tabCount} tabs</span>
        )}
        {title && <span className="min-w-0 flex-1 truncate text-neutral-500" title={title}>{title}</span>}
        {!title && <span className="flex-1" />}

        {/* Recording. `browser_start_video` needs --caps=devtools on the MCP spawn (see manager.ts) —
            it's the closest analogue to Claude Code's gif_creator, and a genuinely useful QA artifact. */}
        <button
          onClick={() => ask(recording
            ? "Stop the browser video recording and tell me where the file was saved."
            : "Start recording a video of the browser, then continue.")}
          disabled={!live} title={recording ? "Stop recording" : "Record a video of the browser"}
          className={`flex shrink-0 items-center gap-1 rounded px-1 py-0.5 transition-colors disabled:opacity-30 ${recording ? "text-[#ef7c7c]" : "hover:bg-white/10 hover:text-neutral-300"}`}>
          {recording ? <Square className="h-2.5 w-2.5 fill-current" /> : <Circle className="h-2.5 w-2.5" />}
          {recording && "rec"}
        </button>
        {onToggleLayout && (
          <button onClick={onToggleLayout} title={stacked ? "Move to the side of the chat" : "Move below the chat"}
            className="shrink-0 rounded px-1 py-0.5 transition-colors hover:bg-white/10 hover:text-neutral-300">
            {stacked ? "▤" : "▥"}
          </button>
        )}
        {onPopOut && (
          <button onClick={onPopOut} title="Open in its own window"
            className="shrink-0 rounded px-1 py-0.5 transition-colors hover:bg-white/10 hover:text-neutral-300">⧉</button>
        )}
      </div>

      {/* Device presets as an inline row, NOT a floating dropdown. An absolutely-positioned menu is
          clipped here: the chat pane is `overflow-hidden` and this panel can be ~160px wide in a 4-pane
          grid, so a 160px menu anchored to a button near the panel's left edge gets cut in half. A row
          that flows inside the panel works at every width. */}
      {deviceOpen && (
        <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.07] bg-black/30 px-2 py-1">
          {DEVICES.map(({ label, w, h, Icon }) => (
            // The icon carries the device identity (Tablet vs Smartphone are visually distinct) and the
            // number carries the size, so this stays readable at ~160px where a "Desktop"/"iPhone" label
            // would truncate to an ambiguous "D…"/"iP…". Full detail lives in the tooltip.
            <button key={label} title={`${label} — ${w}×${h}`}
              onClick={() => { ask(`Resize the browser viewport to ${w}x${h} and take a screenshot.`); setDeviceOpen(false); }}
              className="flex min-w-0 flex-1 items-center justify-center gap-1 rounded border border-white/10 px-1 py-0.5 text-[9px] tabular-nums text-neutral-400 transition-colors hover:border-[#5ec8f8]/50 hover:text-neutral-100">
              <Icon className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{w}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Zone 2: the viewport ──────────────────────────────────────────────────────────────── */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2"
        style={{ backgroundImage: "repeating-conic-gradient(rgba(255,255,255,0.03) 0% 25%, transparent 0% 50%)", backgroundSize: "16px 16px" }}
      >
        {src ? (
          <button onClick={() => onOpenShot(shownIdx)} title="Click to view full size"
            className="group flex max-h-full max-w-full items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={shot?.action || ""}
              onError={() => shot && setDead((d) => ({ ...d, [shot.id]: true }))}
              className="max-h-full max-w-full rounded border border-white/10 object-contain shadow-lg transition-opacity group-hover:opacity-90" />
          </button>
        ) : state.everUsed ? (
          // Active browser, no pixels. Extremely common: an accessibility snapshot is cheaper than a
          // screenshot, so Claude often never takes one. Say so, and offer the one-click fix.
          <div className="max-w-[16rem] px-3 text-center">
            <Camera className="mx-auto mb-2 h-5 w-5 text-neutral-700" />
            <p className="text-[11px] leading-relaxed text-neutral-500">
              {busy ? "waiting for a screenshot…"
                : shots.length ? "this screenshot's pixels are gone — inline images don't survive a reload, and the file on disk was cleaned up"
                : url ? "Claude is reading this page as an accessibility tree — cheaper than pixels, but nothing to look at."
                : "no screenshot yet"}
            </p>
            {live && !busy && (
              <button onClick={() => onAsk("Take a screenshot of the current browser page.")}
                className="mt-2 rounded-md border border-white/15 px-2 py-1 text-[10px] text-neutral-300 transition-colors hover:border-[#5ec8f8]/50 hover:text-white">
                Ask for a screenshot
              </button>
            )}
          </div>
        ) : (
          <p className="px-4 text-center text-[11px] leading-relaxed text-neutral-600">no browser activity yet</p>
        )}

        {/* Stale hint — mirrors Claude Code's own guard ("Screen content … changed since the last
            screenshot"). Without it, an old frame reads as the current state of the page. */}
        {src && following && staleBy > 0 && (
          <span className="absolute left-3 top-3 rounded-full bg-black/70 px-2 py-0.5 text-[9px] text-neutral-400 backdrop-blur">
            {staleBy} action{staleBy === 1 ? "" : "s"} ago
          </span>
        )}
        {src && !following && (
          <button onClick={() => setPinned(null)}
            className="absolute left-3 top-3 flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[9px] text-neutral-300 backdrop-blur transition-colors hover:text-white">
            <Radio className="h-2.5 w-2.5" /> back to live
          </button>
        )}
        {busy && actionLabel && (
          <span className="absolute bottom-3 left-3 right-3 flex items-center gap-1.5 truncate rounded-md bg-black/70 px-2 py-1 text-[10px] text-neutral-300 backdrop-blur">
            <span className="think-dot h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TINT }} />
            {actionLabel}
          </span>
        )}
      </div>

      {/* ── Zone 3: filmstrip ─────────────────────────────────────────────────────────────────── */}
      {shots.length > 1 && (
        <div ref={strip} className="flex shrink-0 gap-1 overflow-x-auto border-t border-white/[0.07] px-2 py-1.5">
          {shots.map((s, i) => {
            const thumb = dead[s.id] ? null : shotSrc(s, cwd, false);
            const on = i === shownIdx;
            return (
              <button key={s.id} onClick={() => setPinned(i === shots.length - 1 ? null : i)} onDoubleClick={() => onOpenShot(i)}
                title={`${s.action}${s.url ? ` — ${s.url}` : ""}\nDouble-click to open full size`}
                className={`shrink-0 overflow-hidden rounded border transition-colors ${on ? "border-[#5ec8f8]" : "border-white/10 hover:border-white/30"}`}>
                {thumb
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={thumb} alt="" onError={() => setDead((d) => ({ ...d, [s.id]: true }))} className="h-9 w-auto max-w-[72px] object-cover" />
                  : <span className="flex h-9 w-12 items-center justify-center text-[8px] text-neutral-600">—</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Zone 4: the drawer ────────────────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-white/[0.07]">
        <div className="flex items-center gap-0.5 px-2 py-1">
          {(["console", "network", "actions"] as Tab[]).map((t) => {
            const n = t === "console" ? state.consoleLines.length || errCount : t === "network" ? network.length : actions.length;
            return (
              <button key={t} onClick={() => setTab(tab === t ? null : t)}
                className={`rounded px-1.5 py-0.5 text-[10px] capitalize transition-colors ${tab === t ? "bg-white/10 text-neutral-200" : "text-neutral-600 hover:text-neutral-400"}`}>
                {t}{n ? <span className="ml-1 tabular-nums text-neutral-500">{n}</span> : null}
              </button>
            );
          })}
          <span className="ml-auto text-[9px] text-neutral-700">{tab ? "click to collapse" : ""}</span>
        </div>

        {tab === "console" && (
          <Drawer>
            {consoleBody.length ? consoleBody.map((l, i) => (
              <p key={i} className={`truncate font-mono ${/^\s*\[ERROR\]/i.test(l) ? "text-[#ef7c7c]" : /^\s*\[WARNING\]/i.test(l) ? "text-[#f0a868]" : "text-neutral-500"}`} title={l}>{l}</p>
            )) : (
              <Empty>
                {errCount > 0
                  ? `The page reported ${errCount} error${errCount === 1 ? "" : "s"}, but the messages themselves live in a separate log.`
                  : "No console errors reported."}
                {live && errCount > 0 && (
                  <button onClick={() => onAsk("Read the browser console messages (errors only) and summarise what's failing.")}
                    className="mt-1.5 block rounded border border-white/15 px-2 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-[#5ec8f8]/50 hover:text-white">
                    Read the console
                  </button>
                )}
              </Empty>
            )}
          </Drawer>
        )}

        {tab === "network" && (
          <Drawer>
            {network.length ? network.map((r, i) => (
              <p key={i} className="flex gap-1.5 truncate font-mono">
                <span className="w-10 shrink-0 text-neutral-600">{r.method}</span>
                <span className={`w-7 shrink-0 tabular-nums ${r.status && r.status >= 400 ? "text-[#ef7c7c]" : "text-[#4ade80]"}`}>{r.status ?? ""}</span>
                <span className="truncate text-neutral-500" title={r.url}>{r.url.replace(/^https?:\/\//, "")}</span>
              </p>
            )) : (
              <Empty>
                Nothing captured — network requests are only reported when Claude asks for them.
                {live && (
                  <button onClick={() => onAsk("List the browser's network requests (skip static assets) and flag any that failed.")}
                    className="mt-1.5 block rounded border border-white/15 px-2 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-[#5ec8f8]/50 hover:text-white">
                    List requests
                  </button>
                )}
              </Empty>
            )}
          </Drawer>
        )}

        {tab === "actions" && (
          <Drawer>
            {actions.length ? [...actions].reverse().map((a) => (
              <p key={a.id} className="flex items-center gap-1.5 truncate">
                <span className="shrink-0" style={{ color: a.done ? (a.ok === false ? "#ef7c7c" : "#4ade80") : "#525252" }}>
                  {a.done ? (a.ok === false ? "✗" : "✓") : "⋯"}
                </span>
                <span className="shrink-0 text-neutral-400">{a.verb}</span>
                {a.arg && <span className="truncate font-mono text-neutral-600">{a.arg}</span>}
                {a.hadImage && <Camera className="h-2.5 w-2.5 shrink-0 text-neutral-700" />}
                {a.ms != null && <span className="ml-auto shrink-0 tabular-nums text-neutral-700">{a.ms}ms</span>}
              </p>
            )) : <Empty>No browser actions yet.</Empty>}
          </Drawer>
        )}
      </div>
    </div>
  );
}

function Nav({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      className="shrink-0 rounded-md px-1 py-1 text-neutral-500 transition-colors hover:bg-white/10 hover:text-neutral-200 disabled:opacity-25 disabled:hover:bg-transparent">
      {children}
    </button>
  );
}

const Drawer = ({ children }: { children: React.ReactNode }) => (
  <div className="max-h-32 space-y-0.5 overflow-y-auto border-t border-white/[0.05] bg-black/30 px-2 py-1.5 text-[10px] leading-relaxed">{children}</div>
);

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[10px] leading-relaxed text-neutral-600">{children}</div>
);
