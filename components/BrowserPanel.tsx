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
//
// ── Layout: one bar, one hero, two overlays ────────────────────────────────────────────────────────
// v1 stacked four permanent rows of chrome (toolbar · status strip · filmstrip · drawer tabs) above a
// viewport that had whatever height was left. In a side panel next to a chat that's most of the panel
// spent on controls, and the thing you actually came to look at — the page — was the smallest part.
//
//   Simplicity · ONE bar. Navigation, address, problems, and two disclosures. Nothing else is
//               permanent, so the frame is the hero at every panel size.
//   Hide       · Everything rare — device presets, recording, layout, pop-out, copy, open-externally,
//               profile facts — lives behind a single ⋯ menu. Console/network/actions live behind one
//               drawer toggle rather than three always-on tabs. Both are one click from anywhere.
//   Embody     · The panel behaves like a browser: the frame fills it, a stale frame *looks* stale
//               (dimmed, not just labelled), recording shows as a red pulse on the panel itself, and
//               the filmstrip is a scrubber that appears over the page when you reach for it — the way
//               video controls do — instead of permanently taxing the height.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera, Chrome, Circle, ExternalLink, Globe, Monitor, PanelRightClose,
  RefreshCw, Smartphone, Square, Tablet, ArrowLeft, ArrowRight, Copy, Check, Radio,
  MoreHorizontal, Film,
} from "lucide-react";
import type { BrowserState, Shot } from "@/lib/browser-view";
import { PanelTabs } from "./PanelTabs";
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

// The page is a tab among peers, not a hero with a drawer under it — which is what makes this panel
// and the file preview the same shape: one header, one tab row, one content area. The drawer it
// replaces was a third layout state (bar · page · drawer) that had to be opened before you could learn
// there was anything in it; a tab row carries its counts at rest.
type Tab = "page" | "console" | "network" | "actions";

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
  const [tab, setTab] = useState<Tab>("page");
  const [menu, setMenu] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);
  const [copied, setCopied] = useState(false);
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
  const consoleBody = useMemo(() => state.consoleLines.filter(() => tab === "console"), [state.consoleLines, tab]);

  const ask = (p: string) => { if (live) onAsk(p); };

  return (
    // `flex-1 min-h-0` in BOTH orientations, deliberately. With `shrink-0` when stacked, this root
    // refused to shrink below its content height inside a fixed-height wrapper, so the filmstrip and
    // drawer were clipped off the bottom of the pane. Filling the parent and letting the viewport (the
    // one `flex-1` child) absorb the difference is what keeps the chrome reachable at any height.
    //
    // `@container` so the bar can thin itself out by the PANEL's width, not the window's — this thing
    // is ~160px wide in a 4-pane grid and full-width when popped out, at the same viewport size.
    <div className={`@container flex min-h-0 flex-1 flex-col bg-black/20 ${stacked ? "border-t" : "border-l"} border-white/10`}>

      {/* ── The one bar ───────────────────────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-white/[0.07] px-1.5 py-1">
        {/* Back/forward are the first thing to go when the panel is narrow: they're the least-used
            controls here (the agent navigates by intent, not by history) and cost 44px. */}
        <Nav title="Back" onClick={() => ask("Go back in the browser, then take a screenshot.")} disabled={!live} className="@max-[300px]:hidden"><ArrowLeft className="h-3.5 w-3.5" /></Nav>
        <Nav title="Forward" onClick={() => ask("Go forward in the browser, then take a screenshot.")} disabled={!live} className="@max-[300px]:hidden"><ArrowRight className="h-3.5 w-3.5" /></Nav>
        <Nav title="Reload" onClick={() => ask("Reload the current page in the browser, then take a screenshot.")} disabled={!live || !url}>
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
        </Nav>

        {/* URL bar — editable. Enter asks the agent to navigate. */}
        <div className="group/url flex min-w-[4.5rem] flex-1 items-center gap-1 rounded-md border border-white/10 bg-black/40 px-1.5 py-0.5 focus-within:border-[#5ec8f8]/50">
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
              // The page title used to have its own row. It's the same fact as the URL, so it's the
              // URL's tooltip now — one line of chrome recovered for the page itself.
              title={[title, live ? (url ? `${url} — click to edit and navigate` : "Click to enter a URL") : url || ""].filter(Boolean).join("\n")}
              className="min-w-0 flex-1 truncate text-left text-[11px] text-neutral-300 disabled:cursor-default">
              {url ? url.replace(/^https?:\/\//, "") : <span className="text-neutral-600">no page yet</span>}
            </button>
          )}
          {httpStatus !== undefined && httpStatus >= 400 && (
            <span className="shrink-0 rounded px-1 text-[9px] font-semibold text-[#ef7c7c]">{httpStatus}</span>
          )}
          {/* Revealed by proximity rather than parked in the menu: opening a localhost dev server for
              real is the single most-reached-for thing here, and it belongs on the address it opens. */}
          {url && (
            <button title="Open in your own browser" onClick={() => window.open(url, "_blank", "noreferrer")}
              className="shrink-0 text-neutral-700 opacity-0 transition-[opacity,color] hover:text-neutral-200 focus:opacity-100 group-hover/url:opacity-100">
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* The console-error badge used to live here, because a problem you have to open a menu to
            discover is a problem you don't discover. It still doesn't have to be discovered — the
            Console tab below carries the same count, in red, at rest. Two badges for one fact is one
            more than the bar has room for at ~160px. */}
        <Nav title="Viewport, recording, layout" onClick={() => setMenu((v) => !v)}
          className={`relative ${menu ? "bg-white/10 text-neutral-200" : ""}`}>
          <MoreHorizontal className="h-3.5 w-3.5" />
          {/* Recording is the one hidden state that must stay visible — it writes a file and keeps
              running. A red pulse on the control that can stop it is the whole disclosure. */}
          {recording && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-[#ef7c7c]" />}
        </Nav>
        {onClose && <Nav title="Hide the browser panel" onClick={onClose}><PanelRightClose className="h-3.5 w-3.5" /></Nav>}
      </div>

      {/* ── The ⋯ menu ────────────────────────────────────────────────────────────────────────────
          An inline panel, NOT an absolutely-positioned dropdown. A floating menu is clipped here: the
          chat pane is `overflow-hidden` and this panel can be ~160px wide in a 4-pane grid, so a menu
          anchored near its left edge gets cut in half. A block that flows inside the panel works at
          every width, and stacking its rows means nothing has to truncate. */}
      {menu && (
        <div className="shrink-0 space-y-1.5 border-b border-white/[0.07] bg-black/30 px-2 py-1.5">
          <Row label="Size">
            {DEVICES.map(({ label, w, h, Icon }) => (
              // The icon carries the device identity (Tablet vs Smartphone are visually distinct) and
              // the number carries the size, so this stays readable at ~160px where a "Desktop"/
              // "iPhone" label would truncate to an ambiguous "D…"/"iP…". Detail is in the tooltip.
              <button key={label} title={`${label} — ${w}×${h}`} disabled={!live}
                onClick={() => { ask(`Resize the browser viewport to ${w}x${h} and take a screenshot.`); setMenu(false); }}
                className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded border px-1 py-0.5 text-[9px] tabular-nums transition-colors disabled:opacity-30 ${
                  viewport === `${w}x${h}` ? "border-[#5ec8f8]/60 text-[#5ec8f8]" : "border-white/10 text-neutral-400 hover:border-[#5ec8f8]/50 hover:text-neutral-100"}`}>
                <Icon className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{w}</span>
              </button>
            ))}
          </Row>
          <Row label="Capture">
            <MenuBtn title="Take a screenshot now" disabled={!live} onClick={() => { ask("Take a screenshot of the current browser page."); setMenu(false); }}>
              <Camera className="h-2.5 w-2.5" /> shot
            </MenuBtn>
            {/* `browser_start_video` needs --caps=devtools on the MCP spawn (see manager.ts) — the
                closest analogue to Claude Code's gif_creator, and a genuinely useful QA artifact. */}
            <MenuBtn title={recording ? "Stop recording" : "Record a video of the browser"} disabled={!live} active={recording}
              onClick={() => { ask(recording ? "Stop the browser video recording and tell me where the file was saved." : "Start recording a video of the browser, then continue."); setMenu(false); }}>
              {recording ? <Square className="h-2.5 w-2.5 fill-current" /> : <Circle className="h-2.5 w-2.5" />} {recording ? "stop" : "rec"}
            </MenuBtn>
            {url && (
              <MenuBtn title={copied ? "Copied" : "Copy URL"} onClick={() => { navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>
                {copied ? <Check className="h-2.5 w-2.5 text-[#4ade80]" /> : <Copy className="h-2.5 w-2.5" />} url
              </MenuBtn>
            )}
          </Row>
          {(onToggleLayout || onPopOut) && (
            <Row label="Window">
              {onToggleLayout && (
                <MenuBtn title={stacked ? "Move to the side of the chat" : "Move below the chat"} onClick={() => { onToggleLayout(); setMenu(false); }}>
                  {stacked ? "▤" : "▥"} {stacked ? "side" : "below"}
                </MenuBtn>
              )}
              {onPopOut && <MenuBtn title="Open in its own window" onClick={() => { onPopOut(); setMenu(false); }}>⧉ pop out</MenuBtn>}
            </Row>
          )}
          {/* The profile facts are reference, not control — last, small, and never in the way. */}
          <p className="flex items-center gap-1 pt-0.5 text-[9px] text-neutral-600"
            title="Each chat gets its own in-memory browser profile — no cookies, nothing on disk, nothing shared between chats">
            <Chrome className="h-2.5 w-2.5 shrink-0" style={{ color: TINT }} strokeWidth={2.25} />
            headless · isolated{viewport ? ` · ${viewport}` : ""}{state.tabCount !== undefined && state.tabCount > 1 ? ` · ${state.tabCount} tabs` : ""}
          </p>
        </div>
      )}

      {/* ── The tab row — the same component the file preview wears ───────────────────────────── */}
      <PanelTabs
        tabs={[
          { key: "page", label: "Page", icon: <Globe className="h-3 w-3 shrink-0 text-neutral-500" />, count: shots.length > 1 ? shots.length : 0 },
          // The count is errors-or-lines, whichever we actually have: a session where Claude never read
          // the console still knows how many errors the page reported, and that number is the reason
          // you'd open the tab. `alert` paints it red, which is the badge this replaced.
          { key: "console", label: "Console", count: state.consoleLines.length || errCount || consoleWarnings, alert: problem || errCount > 0 },
          { key: "network", label: "Network", count: network.length },
          { key: "actions", label: "Actions", count: actions.length },
        ]}
        active={tab}
        // Selecting a tab NAVIGATES. Nothing else.
        //
        // The console badge this replaced used to send the agent a "read the console" prompt on click,
        // and porting that onto the tab was a real mistake, caught by using it: clicking Console
        // silently started a turn in a live session — a send, from a control that looks like a view
        // switch. A badge you press is a verb; a tab is a place. The prompt still exists, on the button
        // inside the empty Console tab, where it reads as the action it is.
        onPick={(k) => { setMenu(false); setTab(k as Tab); }}
      />

      {/* ── The page ──────────────────────────────────────────────────────────────────────────── */}
      <div
        // Hidden rather than unmounted, so switching to Console and back doesn't drop the pinned frame,
        // the filmstrip's scroll position, or re-decode every thumbnail.
        className={`group/view relative min-h-0 flex-1 items-center justify-center overflow-hidden p-2 ${tab === "page" ? "flex" : "hidden"}`}
        style={{ backgroundImage: "repeating-conic-gradient(rgba(255,255,255,0.03) 0% 25%, transparent 0% 50%)", backgroundSize: "16px 16px" }}
      >
        {src ? (
          <button onClick={() => onOpenShot(shownIdx)} title="Click to view full size"
            className="group flex max-h-full max-w-full items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={shot?.action || ""}
              onError={() => shot && setDead((d) => ({ ...d, [shot.id]: true }))}
              // A stale frame is *shown* stale rather than only labelled: the pill explains it, the
              // dimming makes you doubt it, which is the correct instinct about an old screenshot.
              className={`max-h-full max-w-full rounded border border-white/10 object-contain shadow-lg transition-opacity group-hover:opacity-90 ${
                following && staleBy > 0 ? "opacity-70" : ""}`} />
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

        {/* ── Scrubber: the filmstrip, over the page instead of under it ───────────────────────
            It used to hold ~46px of permanent height for something you look at occasionally. Now it
            behaves like a video player's controls: a hairline that says how many frames exist, opening
            to thumbnails on hover — and staying open whenever you've pinned a frame, because then it's
            the only way back. */}
        {shots.length > 1 && (
          <div className={`absolute inset-x-0 bottom-0 transition-transform duration-200 ${
            following ? "translate-y-[calc(100%-6px)] group-hover/view:translate-y-0" : "translate-y-0"}`}>
            <div className="flex items-center gap-1 bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-4">
              <Film className="h-3 w-3 shrink-0 text-neutral-500" />
              <div ref={strip} className="flex flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {shots.map((s, i) => {
                  const thumb = dead[s.id] ? null : shotSrc(s, cwd, false);
                  const on = i === shownIdx;
                  return (
                    <button key={s.id} onClick={() => setPinned(i === shots.length - 1 ? null : i)} onDoubleClick={() => onOpenShot(i)}
                      title={`${s.action}${s.url ? ` — ${s.url}` : ""}\nDouble-click to open full size`}
                      className={`shrink-0 overflow-hidden rounded border transition-colors ${on ? "border-[#5ec8f8]" : "border-white/10 hover:border-white/40"}`}>
                      {thumb
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={thumb} alt="" onError={() => setDead((d) => ({ ...d, [s.id]: true }))} className="h-9 w-auto max-w-[72px] object-cover" />
                        : <span className="flex h-9 w-12 items-center justify-center text-[8px] text-neutral-600">—</span>}
                    </button>
                  );
                })}
              </div>
              <span className="shrink-0 text-[9px] tabular-nums text-neutral-500">{shownIdx + 1}/{shots.length}</span>
            </div>
          </div>
        )}
      </div>

      {/* ── The other three tabs ──────────────────────────────────────────────────────────────────
          These were a drawer pinned to a `max-h-32` strip under the page. As tabs they get the whole
          content area, which is the actual win: reading a stack trace or a network table in 128px was
          the reason the pop-out window existed. */}
      {tab !== "page" && (
        <div className="flex min-h-0 flex-1 flex-col">
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
      )}
    </div>
  );
}

function Nav({ title, onClick, disabled, className = "", children }: { title: string; onClick: () => void; disabled?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      className={`shrink-0 rounded-md px-1 py-1 text-neutral-500 transition-colors hover:bg-white/10 hover:text-neutral-200 disabled:opacity-25 disabled:hover:bg-transparent ${className}`}>
      {children}
    </button>
  );
}

// A labelled row inside the ⋯ menu. The label is what makes a stack of 9px icon buttons legible.
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center gap-1">
    <span className="w-14 shrink-0 text-[9px] uppercase tracking-[0.08em] text-neutral-600">{label}</span>
    {children}
  </div>
);

const MenuBtn = ({ title, onClick, disabled, active, children }: { title: string; onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) => (
  <button title={title} onClick={onClick} disabled={disabled}
    className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded border px-1 py-0.5 text-[9px] transition-colors disabled:opacity-30 ${
      active ? "border-[#ef7c7c]/60 text-[#ef7c7c]" : "border-white/10 text-neutral-400 hover:border-[#5ec8f8]/50 hover:text-neutral-100"}`}>
    {children}
  </button>
);

// The body of a non-page tab. `flex-1 min-h-0` rather than the old `max-h-32`: it is the content area
// now, not a strip under one.
const Drawer = ({ children }: { children: React.ReactNode }) => (
  <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto bg-black/30 px-2 py-1.5 text-[10px] leading-relaxed">{children}</div>
);

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[10px] leading-relaxed text-neutral-600">{children}</div>
);
