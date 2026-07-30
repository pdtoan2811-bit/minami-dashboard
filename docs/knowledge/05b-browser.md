# Browser panel

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 5b. Browser panel — `lib/browser-view.ts`, `components/BrowserPanel.tsx`, `components/BrowserLightbox.tsx`

Every live chat gets a **headless**, isolated Playwright MCP browser (§3). That single word decides the
whole design. Claude Code's own browser integration drives your *real, visible* Chrome through the
"Claude in Chrome" extension — so it ships **no viewport UI at all**: no screencast, no URL bar, no
back/forward, no screenshot gallery, no element picker, no "take control" button. Its entire surface is
a status panel, a per-domain permission gate, and an activity log, because the live view *is* your
Chrome window. A headless browser has no window, so **Bento's panel has to be the window.** The panel
is therefore not a copy of Claude Code's UI; it's the headless analogue of it.

What *was* worth copying outright is Claude Code's permission and labelling vocabulary, and that's been
ported: a plain-English verb phrase plus a hostname (`Claude wants to fill in a form on
localhost:3000`), a session-scoped "allow all on this host" escape hatch, and compact one-field
argument summaries in the transcript instead of input JSON.

### Mechanics
- **Nothing new is plumbed.** `deriveBrowserState(turns)` folds the whole panel state out of tool
  results that already stream over SSE. Playwright returns ONE text block of markdown sections in a
  fixed order — `### Error`, `### Result`, `### Ran Playwright code`, `### Open tabs`, `### Page`,
  `### Snapshot`, `### Events` — and `### Page` carries `- Page URL:`, `- Page Title:`,
  `- HTTP status:`, `- Console: N errors, M warnings`.
- **Section order is load-bearing.** `summarizeToolResult` caps each text block at 4000 chars (§4) and
  it's a head-cut, so URL/title/console survive but `### Events` can be truncated away. Parse
  defensively; every field is optional by design.
- **The real artifacts are on disk**, in **two** places, and both matter. Playwright MCP writes to
  `<session cwd>/.playwright-mcp/` (full-resolution PNGs, `page-*.yml` snapshots, `console-*.log`) when
  it names the file itself — but pass `filename: "shot.png"` and it saves to `./shot.png`, i.e. the
  **session root**, because the path is relative to the MCP process's cwd. `/api/agent/browser/file`
  checks both, with a bare-filename allowlist. `--output-dir` is deliberately NOT set — the default
  location is the one the client can derive from `cwd`.
- **A named screenshot returns no inline image.** `browser_take_screenshot` with no `filename` comes
  back as text *plus* an image block; with a `filename` it comes back as text only. So for named shots
  the file on disk is the panel's ONLY source — there is no base64 to fall back to.
- **Two image sources, not interchangeable.** Inline base64 is instant but downscaled (≤1568px) and
  stripped from sessionStorage by `trimOutput`, so it's gone after a reload. The disk file is full-res
  and survives, but costs a request and is often genuinely missing. `shotSrc(shot, cwd, preferFile)`
  picks per surface: thumbnails/viewport prefer inline, the lightbox prefers the file.
- **The toolbar drives the agent, not the browser.** There is no server-side handle on the browser, so
  back/forward/reload/URL-bar/device-presets/record all send Claude a message. That's Claude Code's
  model too — navigation is a tool call, not a chrome affordance.
- **`--caps=devtools`** is on the MCP spawn purely so `browser_start_video` exists; without it the
  Record button has nothing to call. The default capability set is 24 tools and excludes video,
  highlight, annotate, tracing and PDF.
- **A screenshot nudge** is appended to the system prompt when the browser tool is registered. Left
  alone Claude prefers `browser_snapshot` (an accessibility tree — cheaper and better for deciding what
  to click), which is correct for the model and invisible to a human watching a panel.

### Layout — one bar, one hero, two overlays
v1 stacked four permanent rows of chrome (toolbar · status strip · filmstrip · drawer tabs) above a
viewport that got whatever height was left. Next to a chat that's most of the panel spent on controls,
and the page — the thing you opened the panel to see — was the smallest part of it. The rebuild applies
**SHE**:

- **Simplicity** — ONE bar: back/forward/reload, the address, the problem badge, and two disclosures.
  Nothing else is permanent, at any panel size.
- **Hide** — everything rare (device presets, record, layout flip, pop-out, copy URL, the
  headless/isolated/viewport/tab facts) is behind a single `⋯` menu; console, network and actions are
  behind one drawer toggle instead of three always-on tabs. **The two are mutually exclusive** — both
  open in a 200px-tall pane leaves no page visible at all.
- **Embody** — the panel behaves like a browser rather than describing one. A stale frame is *dimmed*,
  not just labelled. Recording is a red pulse on the control that stops it. The filmstrip is a scrubber
  that slides up over the page on hover the way video controls do, and stays up while a frame is pinned
  because that's the only way back to live.

**Open-in-your-own-browser** stays on the bar unconditionally, revealed on hover of the address it would
open — opening a localhost dev server for real is the most-reached-for thing here.

### v3 — the drawer becomes tabs, and the panel matches the file preview
The hero-plus-drawer shape above survived one round of use and then lost to a simpler ask: *make the
browser match the file preview*. It now wears the same three-part shape — **header bar · tab row ·
content** — with the page as one tab among **Page · Console · Network · Actions**.

- **The shared row is a component** (`components/PanelTabs.tsx`), worn by both panels. "They match" is a
  claim a screenshot can satisfy and a codebase can't: two hand-built tab rows drift the first time
  either is touched.
- **The console badge left the bar.** It was there because a problem you must open a menu to discover is
  a problem you don't discover — which is still true, and now satisfied by the Console tab carrying the
  same count in red, at rest, without being opened. Two badges for one fact is one more than a ~160px
  bar has room for.
- **The three non-page tabs get the whole content area**, not the old `max-h-32` strip. Reading a stack
  trace or a network table in 128px was most of the reason the pop-out window existed.
- **The page is hidden, not unmounted**, when another tab is up, so switching away and back doesn't drop
  the pinned frame, the filmstrip's scroll position, or re-decode every thumbnail.

> 🐛 **A tab that sent a message.** The console badge's click used to *ask the agent* to read the
> console — a verb, on a control that looked like one. Porting that behaviour onto the Console **tab**
> carried it into a control that looks like a place: clicking Console silently started a turn in a live
> session. Caught by clicking it during verification, on a real chat, which then had to be stopped by
> hand. A tab navigates and does nothing else; the prompt lives on a button inside the empty Console
> tab, where it reads as the action it is. The general rule this is an instance of: **when a control
> changes shape, re-derive its behaviour from the new shape** rather than carrying the old one across.

### Gotchas
- **The bar sizes itself with container queries, not breakpoints.** This panel is ~160px wide in a
  4-pane grid and full-width popped out, at the same window size — `md:` says nothing useful about it.
  The root is `@container`; back/forward drop below 300px and the badge sheds its counts below 260px.
  Never stack a `md:` variant and an `@max-[]` variant on the same property: which wins is source
  order, which is not a contract.
- **`Escape` is contested.** `app/page.tsx`'s window handler closes the whole chat panel on Escape, and
  it checks Escape *before* its input/textarea guard. The lightbox listens in the **capture** phase and
  calls `stopImmediatePropagation`, so it wins regardless of listener registration order. Remove that
  and closing the lightbox nukes the chat pane with it.
- **The `⋯` menu is an inline block, not a dropdown.** The chat pane is `overflow-hidden` and this panel
  can be ~160px wide in a 4-pane grid, so an absolutely-positioned menu anchored near its left edge gets
  sliced in half. A block that flows inside the panel works at every width; stacking its rows means
  nothing has to truncate.
- **Panel root must be `flex-1 min-h-0` in both orientations.** With `shrink-0` when stacked it refused
  to shrink below its content height inside a fixed-height wrapper, clipping the filmstrip and drawer
  off the bottom of the pane.
- **Console *counts* are free; console *text* is not.** An action result only ever reports
  `N errors, M warnings`. The messages need an explicit `browser_console_messages` call, or reading
  `console-*.log` off disk.
- `MINAMI_DISABLE_BROWSER_TOOL=1` stops new sessions getting a browser, but a transcript that already
  used one still renders its panel. That's intended — history is history.

> 🐛 **"View full size" never worked, in either place.** Both the panel preview and the transcript
> thumbnails were `<a href="data:image/png;base64,…" target="_blank">`. **Chrome has blocked top-level
> navigation to `data:` URLs since v60**, so the click did nothing at all — silently, with no console
> error, looking exactly like a dead link. It shipped that way and survived review because a broken
> `target="_blank"` is indistinguishable from a popup blocker at a glance. Both entry points now open a
> real lightbox.
>
> *Reported by user: "I can click on to the browser preview to view it larger."*

> 🐛 **The lightbox opened at half width.** `fixed inset-0` is only viewport-relative when no ancestor
> establishes a containing block — a `transform`, `filter`, `backdrop-filter` or `will-change` is
> enough, and the chat panel sits inside a `backdrop-blur` wrapper. So the "full screen" viewer covered
> just that panel's box. Fixed by portalling to `document.body` (with a mounted guard, since the portal
> target is read at render time and `document` doesn't exist during the server render). Any future
> overlay rendered from inside a pane has this same trap waiting.

> 🐛 **Every named screenshot showed "pixels are gone".** The artifact route only ever looked in
> `<cwd>/.playwright-mcp/`, but Playwright MCP puts a screenshot there only when it picks the name;
> `filename: "shot.png"` lands at `<cwd>/shot.png`. That same call also omits the inline image, so the
> file was the only source — and it 404'd, every time, leaving the honest-but-wrong empty state where
> the page should be. The two facts compound: either alone is survivable, together they mean the
> preview is blank for the whole class of screenshots an agent takes when it wants a stable filename.
> Now the route tries the artifacts dir, then the session root, with the same allowlist (bare filename,
> known extension, resolved path must stay inside the directory it was joined to).
> *Reported by user: "the browser preview is showing nothing when Minami Dashboard use it".*

> 🐛 **Broken-image icons where the page should be.** `shotSrc` preferred the on-disk file whenever a
> filename had been parsed, but the file is frequently absent — the agent ran in a different cwd, or the
> directory was cleaned — and there was no `onError` fallback, so a 404 rendered as a broken-image glyph
> with alt text sitting in the viewport. Every `<img>` now tracks failure and falls back to the honest
> empty state.

---
