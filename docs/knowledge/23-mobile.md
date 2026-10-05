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

### Which screens get the phone shell — `compact:` / `useCompact()`

> 🐛 **The unfolded Find N5 got the desktop.** Reported: "On find n5, the screen go as if it's a
> desktop". The phone shell (bottom bar, sheet, edge-to-edge pane, bottom home nav) was keyed to
> `max-width: 639px`, and an unfolded N5 is ~750px. So it got the tab strip, the top chrome, the
> framed pane and the mouse-sized controls. Width alone can't tell a foldable from a small laptop
> window; the input device can. **Fix:** one definition, used in both places. In CSS it is the
> `compact:` variant in `app/globals.css`; in JS it is `COMPACT_QUERY` / `useCompact()` in
> `lib/use-media.ts`. The rule is narrow (<640px) **or** touch-only (`hover: none` + `pointer: coarse`)
> up to 1199px. Compact also forces tabs view, keeps the bento column off while a topic is open, drops
> the divider, and stacks the side slot like a phone. Verified with touch at 750×826 and 856×945, both
> in the shell. With a mouse at 750×826 the desktop layout is unchanged.
>
> The variant has to be written in **block form** (two `@slot`s). The one-line shorthand with a
> comma-separated query compiled to the first query only and silently dropped the touch half: the JS
> side switched over and the CSS side didn't, so the bar appeared under a framed desktop pane.

### The chat bar and sheet, below 640px — `components/ChatSheet.tsx`

A second pass on the same day, after using it, not auditing it ("layout awful, switching chats
awful, closing chats awful, buttons too small"). Measured at 412×915 with touch emulation, the
panel's chrome was a tab strip of three 68px tabs truncated to "Verify di…". Each tab's ✕ was a
**16×11px** target. There was a second ✕ in the pane header, which also closed the chat, and a third
beside ＋, which closed the whole *project*. So three close glyphs did two different things, and none
of them was thumb-sized. Every icon in the pane header was 20–26px.

Below 640px (the same threshold as `gridFits`: room for two panes side by side is also room for a
readable tab strip) the strip is replaced by **one bar**:

- **‹ back** to all topics (the old esc ✕), 40px.
- **The current chat as one button**: status dot, full-width title, `2/3`. Tapping it opens the sheet.
  A horizontal swipe *on the bar* steps through the open chats. The swipe is on the bar only, because
  the transcript scrolls code blocks sideways.
- **＋** for a new chat, 40px.

The sheet lists the open chats as 56px rows, each with its own 44px ✕. Below them are *New chat* and
the topic's other chats. When all four slots are taken, picking another chat swaps it into the
current pane through the same `switchGen` remount as the desktop ⌄ switcher, rather than refusing.
The pane's own ⌄ and ✕ are hidden at this width, because the bar and the sheet own switching and
closing.

**Bottom-docked (second revision, same evening).** Asked for: "the UX to navigate should be on the
bottom of the screen, place it well so chat panel and input still intuitive". The bar first shipped at
the *top*, which is the hard-to-reach zone on a 6.9" phone. It now follows Safari's bottom tab bar
(iOS 15+). The bar docks under the composer and you swipe it to switch tabs, so the transcript,
the input and navigation all sit in one band at the bottom of the screen. The top chrome is
gone on a phone. Material 3 allows the keyboard to cover the navigation bar temporarily, so the bar is
**hidden while the keyboard is up** and the composer sits directly on the keyboard. "Keyboard up"
means an editable field has focus *and* the viewport has shrunk below 80% of the tallest it has been.
Focus alone is not enough: Android's Back dismisses the keyboard and leaves the textarea focused, which
would strand the bar hidden (verified both ways). On the home screen, search plus Bento/Metrics/Settings
dock to the bottom too. That bar is `fixed`, so it rides up on the keyboard while you search.

Also in this pass:

- **Edge to edge.** Below 640px a focused pane loses its frame (padding, border, radius).
- **Touch sizes.** Pane-header icons are ≥40px under `pointer-coarse:`. The tab ✕, ＋ and project ✕
  also grow there, which covers the unfolded N5, where the tab strip stays.
- **No featured 2×2 tile on a phone.** The heaviest topic's double-height card was half a screen of
  empty space, and squashing it into one row clipped its stats. Below 640px it is an ordinary wide
  tile. The search box takes its own full-width row.
- **The isolated-worktree banner** drops its explanation clause on a phone. Before, it ran off the
  edge and took the *merge back* button with it.

### Android Back and the soft keyboard — `lib/use-back.ts`, `components/Composer.tsx`

**Back.** The dashboard is one URL, so Back (button or edge swipe) from anywhere left the page, or
closed the installed app: from inside a topic, with the chat sheet up, in a lightbox. Each open layer
now owns one `history` entry, registered with `useBackLayer(open, close)`, and Back closes the
topmost one. The layers are the topic, the chat sheet, the flow, the folder pickers, the ＋ menu, the
pane's chat menu, the screenshot lightbox, and the phone side slot (only the *visible* pane's slot,
because a tab you switched away from keeps its slot open underneath). The order is the order of
opening, so the sheet closes before the topic.

The hard case is a layer closed by the UI. Its history entry is still there, and the next Back would
land on it and appear to do nothing. A UI close therefore marks its layer dead, and `flush` rewinds
over every dead entry at the top in **one** `history.go(-n)`. Leaving a topic closes its sheet in the
same render, and several separate async traversals would race. The layers being rewound are removed
**by identity**, because a `pushState` lands synchronously while the traversal does not, and removing
by count from the top would splice off the newly opened layer. Entries left over from before a reload
are skipped. URLs never change: a URL that named a sheet would have to restore it on reload.

Verified on a production build with touch emulation:

| Sequence | Result |
|---|---|
| sheet open, Back | sheet closes, still in the topic |
| pick a chat in the sheet, Back | home |
| side slot open, Back | slot closes; Back again goes home |
| ‹ in the UI, then Back | leaves the page (no dead entry) |

**Enter.** A phone keyboard has no Shift, so Enter-sends meant you could never write a second line.
On a touch-only device (`(hover: none) and (pointer: coarse)`) Enter is a newline that continues
lists the way Shift+Enter does, and ↵ sends. `enterKeyHint` makes the keyboard's action key say which
behaviour you'll get.

> 🐛 **The installed app kept running the old build.** Reported the evening it shipped: "on the web
> installed version to android, the back and all intuitive UX didnt work". Android keeps an installed
> web app's page alive in the background, so after a deploy it went on running the JavaScript it had
> loaded earlier: the tab strip, no Back handling. Fresh tabs were fine. Nothing in the app ever asked
> whether it was current. The prerendered `/` also went out with only `s-maxage`, a CDN directive
> that leaves the browser free to reuse the HTML shell.
> **Fix:** `next.config.mjs` stamps a build id (`env.MINAMI_BUILD`), which is inlined into the client
> bundle and into `/api/build` alike. `lib/use-build-refresh.ts` asks for the server's id whenever the
> page comes back to the foreground (`visibilitychange`, `pageshow`) and reloads if it differs. It
> checks on foreground, not on a timer, so a reload never lands mid-read. Drafts and the open topic
> already survive a reload (verified). `/` is now served `Cache-Control: no-cache`. A phone that
> installed the app before this fix still needs closing once by hand (swipe it out of recents); every
> deploy after that updates on its own.

### Installing it as an app

`app/manifest.ts` + `public/app-icon-{192,512}.png` (the 🌸 on the ground gradient, full-bleed so one
file serves as both the `any` and the `maskable` icon). On Chrome for Android, *Add to Home screen* then
installs a standalone app, with no URL bar and its own task-switcher entry. Installation needs a secure
origin. On the author's box that is the tailnet-only `tailscale serve` URL; plain
`http://<lan-ip>:3000` still works, but only as a tab.

### Localhost links, opened from the phone — `lib/open-local.ts`, `/api/tailnet/expose`

Replies name `http://localhost:<port>` because that is true on the box, and the preview chips and
Markdown links used it as the href. Tapped on the phone, it opened the phone's own localhost: a dead tab.
Reported 2026-10-05 on the ecvision topic, whose chips all pointed at `localhost:3021`.

When the page is **not** on loopback, a tap on a localhost link opens a blank tab synchronously, then
asks the server for that port's tailnet address and redirects the tab there. The tab has to open
before the `await`, because a `window.open` after one is no longer inside the user gesture, and mobile
Chrome drops that popup with no message. On the box itself, nothing changes.

The server (`lib/tailnet.ts`) reads `tailscale serve status --json` and matches on the **proxy
target**, not on the listening port. The dashboard is `:443 → 127.0.0.1:3000`, so `localhost:3000` has
to come back as the bare host. If no entry exists and something answers on the port, it adds
`tailscale serve --bg --https=<port> http://127.0.0.1:<port>`. That entry persists until `serve
--https=<port> off`. It never creates an entry for a port with nothing on it, and it refuses ports below
1024, so a stray request cannot replace the dashboard's own :443. It uses serve and never funnel: serve
is tailnet-only, and anyone on the tailnet can already drive the dashboard, so it exposes nothing new.

> 🐛 **The first version still couldn't open the ecvision pitch bench.** Reported the same evening:
> its chips point at `localhost:3120`, a Vite server started with `host: "localhost"`, and on this Mac
> that binds **`[::1]` only**. Three things were wrong at once. The probe tried only `127.0.0.1`, so it
> answered "nothing is running". Proxying to `[::1]` doesn't work either: serve stores it as
> `http://::1:3120` and answers every request with `unknown proxy destination`. Behind both of those,
> Vite's DNS-rebinding guard 403s every Host it wasn't told about, and serve passes the `.ts.net`
> Host through unchanged.
> **Fix:** the probe tries both families. An IPv6-only server is proxied by the *name* `localhost`,
> which resolves to both. The bench's `vite.config.mjs` got `allowedHosts: [".ts.net"]`. Any other
> Vite app opened this way needs the same line. A Next dev server loads without it, but its HMR
> socket is refused until `allowedDevOrigins` lists the host.

**On a phone the preview opens inside the app** (`components/PreviewOverlay.tsx`). From the installed
app, a new tab is a Chrome tab in a separate task. Back there closed it and dropped you in Chrome or
on the home screen, never back in the chat. Reported: "when i back, im out of the app". On a
touch-only device `openLocalUrl` now fires `minami:preview` instead. The overlay frames the tailnet
URL and is a `useBackLayer` layer. The framed page's own navigations stack *above* that layer's
history entry, so Back walks the preview's pages first and then closes it. Verified through the
tailnet against the :3120 bench: open the chip, go to `/` inside the frame, Back → `/close-widgets/`,
Back → the chat. The ↗ button still opens a real tab, for pages that refuse to be framed.

Not covered: bare URLs in prose, which the Markdown renderer doesn't turn into links at all. The §21
comment pop-out, which iframes the localhost URL, is also not covered.

### How to re-audit

There is no checked-in harness. The audit was two throwaway Playwright scripts (route × viewport
screenshots plus an overflow scan, then a touch walk-through of a pane), and the overflow scan was the
less useful half, for the reason above. What finds these bugs is a `hasTouch: true, isMobile: true`
context that **taps** through the panel: open a tile, switch tabs, open the slot, open the add menu.
Never type into a pane in such a run. A pane on a dev instance is a real session.
