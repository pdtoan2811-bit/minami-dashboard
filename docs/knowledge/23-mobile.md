# The phone view — driving the dashboard from a phone

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 23. Phone and foldable layouts — `app/page.tsx`, `lib/use-media.ts`, `app/manifest.ts`

The dashboard was built for a desk, and "the phone view works" meant only that `next start` binds
`0.0.0.0`. Audited 2026-10-05 on the two phones it is actually used from, all four screens:

| Screen | CSS viewport | Tier a focused pane gets |
|---|---|---|
| Galaxy Z Flip 7, main | 412×960 | tight |
| Galaxy Z Flip 7, cover | 360×400 | micro |
| Find N5, folded | 380×872 | tight |
| Find N5, unfolded | 750×826 | snug/roomy |

No page scrolled sideways (`scrollWidth === innerWidth` everywhere), and that was the misleading part:
the shell is `overflow-hidden`, so everything that was wrong was clipped *inside* it rather than
spilling out. The failures were all behavioural.

### What was wrong, and the rule each fix follows

**Device vs box.** §5e's rule is that chrome is rationed by the *measured box*, never by breakpoint,
and that stays the rule. `lib/use-media.ts` exists for the handful of decisions that are genuinely about
the *device*. The test is: would this be wrong for a 400px pane on a laptop? A narrow pane on a laptop
can be widened by dragging the divider. On a phone, the narrow pane is all the room there is.

- **The side slot was unreachable.** A phone's focused pane is ~400px, which never reaches `snug`, so
  `roomForSlot` was false. The header button's fallback, "expand this pane", was a no-op because the pane
  already had the whole screen. So browser, files and tasks could not be opened from a phone at all. On a
  phone the focused pane now opens the slot **stacked** (55% of the height), whatever the desk's
  side/stacked preference says. It opens only when tapped, through phone-local state (`phoneSlotOpen`),
  never through the persisted `browserHidden`. The persisted setting would let the phone decide whether
  the desktop's panes show their browser, and an auto-opened half-screen panel is the wrong default on a
  6-inch screen.
- **Grid view below 640px is forced to tabs.** Two columns of ~190px don't read as a smaller grid; they
  can't be read at all. Only the *effective* view is overridden. `savedPaneView` is never written, so
  picking up the phone doesn't flip the desk. The unfolded N5 (750px) keeps the grid, because two panes
  side by side really are usable there.
- **Taps triggered behaviour that was meant for keyboard focus.** The panel header peek opened on
  `group-focus-within`, and a tap on a tab focuses it. On a phone every tab switch therefore spread the
  header over the pane's own chrome (the chat switcher, the browser/files buttons) and left it there.
  It now opens on `:focus-visible` only, which still covers keyboard users and excludes taps. Hover was
  already safe: Tailwind v4 compiles `hover:` inside `@media (hover: hover)`.
- **Invisible close targets.** An unlit tab's ✕ is `opacity-0` until hover. On touch it was an
  invisible close button sitting on the label, so a thumb aimed at the end of a tab closed the chat.
  `[@media(hover:none)]:pointer-events-none` removes it from hit-testing. On a phone you select the tab,
  then close it.
- **`100vh` is the wrong height on Android.** `h-screen` includes the space behind Chrome's collapsing
  URL bar. All full-height shells now use `h-dvh` / `min-h-dvh`. On its own that still leaves the
  keyboard covering the composer, because Chrome's default `interactive-widget=resizes-visual` overlays
  the keyboard without shrinking the layout viewport. The root viewport sets `resizes-content`, so `dvh`
  follows the keyboard and the composer rides up above it.
- **Clipped rather than wrapped.** The folded footer row (ask progress, mode pill, ctx, tasks, status)
  was one `flex` line of `shrink-0` children, so at 412px "live" was cut in half. It now wraps.
  Markdown tables had `overflow-x-auto` that never engaged, because `overflow-wrap:anywhere` let every
  column collapse to a word per line; a `min-w-[7rem]` cell floor is what makes them scroll.
  `/settings` rows wrap a wide control onto its own line (the text keeps a 14rem floor, so toggles stay
  beside it), and the routing card's seven model chips scroll sideways instead of breaking "449.4k tok".
- **Desk-only chrome.** The `⌥1–4` shortcut labels are hidden below `md` (there is no ⌥ on a phone),
  `esc ✕` becomes `✕`, and the send/stop/attach buttons grow under `pointer-coarse:`.

### Installing it as an app

`app/manifest.ts` + `public/app-icon-{192,512}.png` (the 🌸 on the ground gradient, full-bleed so one
file serves as both the `any` and the `maskable` icon). On Chrome for Android, *Add to Home screen* then
installs a standalone app, with no URL bar and its own task-switcher entry. Installation needs a secure
origin. On the author's box that is the tailnet-only `tailscale serve` URL; plain
`http://<lan-ip>:3000` still works, but only as a tab.

### How to re-audit

There is no checked-in harness. The audit was two throwaway Playwright scripts (route × viewport
screenshots plus an overflow scan, then a touch walk-through of a pane), and the overflow scan was the
less useful half, for the reason above. What finds these bugs is a `hasTouch: true, isMobile: true`
context that **taps** through the panel: open a tile, switch tabs, open the slot, open the add menu.
Never type into a pane in such a run. A pane on a dev instance is a real session.
