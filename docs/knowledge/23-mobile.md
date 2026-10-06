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

### The chat bar and sheet, below 640px — `components/ChatSheet.tsx` (replaced)

> Replaced on 2026-10-06 by the focus dock and sheet (`components/Focus.tsx`; see "Focus" below).
> `ChatSheet.tsx` is deleted. The measurements and the rules below (thumb-sized rows, one close
> meaning one thing, the sheet at the bottom) carried over into its replacement.

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

> 🐛 **2026-10-06 — Metrics and Settings "flashed, then stayed on the bento" on desktop.** With any
> layer open (a chat panel is one), clicking a link to another page unmounted the board, and every
> layer's cleanup marked itself closed by the UI. `flush()` then ran `history.go(-n)` to rewind over their
> entries, which happened just after Next had pushed `/dashboard`, so it went straight back to `/`.
> Desktop only looked different because that's where the links are. Fix (`lib/use-back.ts`): a
> capture-phase click listener notes a link to another path, and each layer records the path it was
> pushed on. Layers torn down by a page change are dropped without rewinding. Their stale entries are
> skipped by `onPop`'s leftover branch if Back ever reaches them. Checked: with a chat open, Metrics and
> Settings stay put, and Back returns to the board.

### The phone redesign: inbox, list-detail, chip — `components/Inbox.tsx`, `lib/seen.ts`

Designed in a three-designer review (Material/foldables, messaging apps, developer tools), two rounds:
proposals, then cross-critique and votes. The user chose list-detail for the unfolded N5, an inbox as
home, the controls folded into a chip, push notifications and a cover-screen view. While it was being
built they added: "work with multiple projects at once, the hierarchy forces many taps to switch".

**What "needs you" means here.** Sessions run `bypassPermissions`, so the server's gate
(`canUseTool`) allows everything except `AskUserQuestion`. Ordinary tool approvals are therefore rare.
The real needs are **a question**, **a plan to review** (ExitPlanMode in Plan mode), **held steps**
under the brake (which auto-*deny* at `expiresAt`), and **permission** prompts in a session set to
ask/auto-edits. `needOf()` in the manager classifies them. `LiveTile` now carries `need`, `needs`,
`ended` (how the last turn ended, with the opening of the reply), `mode` and `hold`. The same data
feeds the inbox, the glance view and web push, through the `liveEvents` emitter.

**Inbox (phone home).** Every chat across all topics, grouped Needs you → Failed → New → Running →
Idle. Failures are their own group because, mixed into Needs you, they'd train the user to skim it.
Status is shown by shape and motion as well as colour: a still ring means it's your turn, a spinning
arc means working. Rows never re-sort while a finger is down. Nothing approves from the list; a row
says what's needed and the decision happens in the chat, next to the transcript. "New" is unread
since last *seen*. `lib/seen.ts` stores that on the server, so the Mac, the N5 and the Flip agree. It
has a `__floor` (when tracking began), so the first day doesn't mark a month of chats new. A pane
marks its chat seen once it has been visible, idle, for 1.2s. A swipe right on a New or Failed row
marks it read.

**One tap to any chat, in any project.** `openChat(sid)` restores or parks the topic through
`openProject`, then focuses the chat, adds it as a pane, or swaps it into the current pane when all
four are taken. `/?open=<sid>` uses the same path; notifications and the glance view land there. The
bottom chat bar's swipe now walks the **most-recently-visited chats across topics** (right = back,
left = forward), like Android's gesture-bar swipe between apps. The MRU list is not reordered during
a swipe sequence (4s), or each swipe would bounce between the same two chats.

**List-detail on the N5 unfolded** (`split` = compact and ≥700px): a 288px list (Inbox | Topics,
icon-only nav) beside the chat. There is no nav rail, because at 750px a rail would leave the chat
under 400px. With no chat selected, the right side says so. While the keyboard is up, the list
collapses to a 72px icon strip.

**Controls chip.** In the phone shell the control row is always folded. The chip shows only what you
changed (the model when it isn't the default, plan/code, the approval level, held). Pause is its own
36px button beside it, because it's needed fast and it's the safe direction. The chip opens a bottom
sheet with thumb-sized rows. Switching *to* bypass asks first; every safer change is instant. Back
closes the sheet.

### Phone access switch — `components/PhoneAccess.tsx`, `/api/tailnet/phone`

A 📱 button in the chat panel's tab bar, with a dot: green means on and a phone is online, amber means
on but no phone is online, red means off or Tailscale is down. Its panel reports the three separate
facts behind "the phone can't connect". Is Tailscale running on the Mac? Does the dashboard's serve
entry exist (`:443 → 127.0.0.1:3000`)? Which phones are online? From the phone, all three failures
look the same: a page that never loads. The switch adds or removes **only** the dashboard's entry;
dev-server entries stay. It is tailnet-only either way and never touches funnel. Switching it off
from a phone asks first, because it cuts off the screen you'd need to switch it back on.

The panel also gives `http://<tailscale-ip>:3000`. The first report (2026-10-06) had both phones
Online in Tailscale and the N5 answering a direct ping, so the network was fine. The likeliest
cause was Android's **Private DNS** overriding MagicDNS, which stops the `.ts.net` name resolving on
the phone. The IP needs no DNS. It works as a browser tab; installing the app needs the https name.

> 🐛 **A verify copy pointed the phone's address at itself.** The first version used
> `process.env.PORT` as the dashboard's port, and `next start -p 3017` sets it. Switching on from the
> test instance rewrote `:443 → 127.0.0.1:3017`, so for under a minute the phone reached a throwaway
> server instead of the dashboard (restored by hand). **Fix:** the switch names the dashboard's port
> explicitly, `MINAMI_DASHBOARD_PORT` (default 3000), because it is about *the* dashboard, not
> whichever instance is answering.

### Installing it as an app

`app/manifest.ts` + `public/app-icon-{192,512}.png` (the 🌸 on the ground gradient, full-bleed so one
file serves as both the `any` and the `maskable` icon). On Chrome for Android, *Add to Home screen* then
installs a standalone app, with no URL bar and its own task-switcher entry. Installation needs a secure
origin. On the author's box that is the tailnet-only `tailscale serve` URL; plain
`http://<lan-ip>:3000` still works, but only as a tab.

Push notifications for the installed app live in their own doc: [§24](24-push.md). Its service worker
has no fetch handler, so it doesn't affect the build-refresh above.

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

### The cover screen — `/glance`, `lib/use-cover.ts`

> **Rebuilt 2026-10-06 (phone pitch round 9, `~/ecvision/pitches/minami-phone`, V2).** The first
> version below was a status board with one button. He uses the cover to *answer*, so it now shows the
> question, its options as plain numbered rows, a one-line answer field, and a switcher pill. Where the
> list below disagrees, this note wins.
> - **Two camera lenses sit in the bottom-RIGHT corner** of the Flex Window. That ~170×96 is an empty
>   spacer: nothing drawn, nothing tappable. The switcher pill sits bottom-LEFT beside it, and the field
>   sits just above it. (The first draft of the pitch put the lenses on the left. He corrected it.)
> - **Lean.** Three type sizes (question 19/25, options/answer 15/21, meta 12–13 grey) and ONE accent,
>   sakura, meaning "you". State marks are neutral shapes, and red is used only for a failure. Round 8
>   had green, amber, red and pink on one 360px screen, and he called it too much.
> - **Answering:** a question is answered through `/api/glance/answer`. It looks up the full question
>   text on the server with `pendingFor()`, because `Need.summary` is cut at 200 chars and an answer
>   keyed to a truncated question lands on nothing. It accepts single questions only. A reply to an idle
>   chat goes through `/api/agent/send` with the chat's own `mode`, because a send without one resets it.
> - **Still never approves.** Permission, plan and held steps show their summary and "Open on main
>   screen ›". The reason below still holds: 360px can't show enough of a command to approve it safely.
> - Pause/Resume all moved into the list frame as a quiet text button.

> **2026-10-06, round 11: the reader** ("I can't read full"). Research (watchOS/Wear OS reading
> guidance, Samsung's One UI cover direction, and a Pinterest board in
> `~/ecvision/pitches/minami-phone/refs/picks`) agreed on two rules. The first screen must answer which
> / what / how far with no scroll. Long text gets its OWN scrolling view one tap away and is never
> line-clamped. Tapping the reply or question (or "Read all ›") opens the reader: the full latest reply
> from `/api/glance/last` (the feed only carries 400 chars, and the transcript route would ship ~160 KB
> to read one message), or the question's full wording (`pendingFor`, since `need.summary` is cut at
> 200), at 16/24, about 40 characters a line, with your last message above it and Reply/Answer below.
> Body text on the cover is 16px everywhere, the watch-reading floor.

> 🐛 **2026-10-06 — on the real Flip the cover was unreadable, with a bottom row you had to scroll
> to** ("confusing, can't read what's happening, progress and switch chat"). Measured on the device
> (`~/.minami/viewports.jsonl`): the cover gives the app a **541×473 CSS window on a 362×400 screen**
> (dpr 2.625). Samsung runs cover apps in a bigger virtual window and scales it down about 0.67×,
> into the area *above* the lenses (541×473 has the aspect of 362×316). So every size rendered at
> two-thirds, and the 96px lens band was reserved twice. Fix (round 10, `app/glance/Glance.tsx`):
> `useCoverZoom` lays the page out in true cover px and uses CSS `zoom` (= innerWidth / screen.width)
> to fill the window. The lens band is gone. The screen answers, in order: which chat (title + state
> in words), what it's doing (the plan step, or the activity with terminal text turned into words), and
> how far (step n of m + segments + "about Nm left"). Switching is two 44px ‹ › buttons with "n of m"
> between them; tap the middle for the list. Checked at 541×473/2.625 against the live feed.

> 🐛 **2026-10-06 — the cover never showed `/glance` on the real Flip ("look nothing like you
> pitched").** `useCoverScreen()` also required `window.screen` to be ≤420×480. On the device, inside
> Good Lock's launcher, it apparently isn't, so the redirect never fired and the cover got the phone
> layout. Now the test is shape only (`pointer: coarse`, ≤560×600, aspect 4:5–5:4). The Flip main
> screen with the keyboard up is still a ≥1.35 portrait strip, and a laptop window isn't coarse. Checked
> in Playwright: cover 360×400 with `screen` = main → /glance; 474×524 → /glance; Flip main, Flip main
> + keyboard (412×560), N5 unfolded and a 400×450 laptop window → stay on /. The redirect now adds
> `?auto=1`, so `/glance` goes back to `/` when you unfold, but not when you opened it on purpose.
> A first try of that check caused a redirect LOOP: during hydration `useSyncExternalStore` returns its
> server value (false), so `/glance` bounced to `/` at once. It now asks `matchMedia` directly.
> `lib/viewport-report.ts` → `/api/viewport` → `~/.minami/viewports.jsonl` records each device's real
> sizes, so the next tuning reads numbers instead of spec sheets.

**The first version (2026-10-05), for the record:**

The Flip 7's Flex Window (~360×400 CSS px, read at arm's length) gave the full board a "micro" pane
that showed nothing usable. `/glance` is a separate route built for that screen. It answers one
question, "does anything need me, and how long has it waited?", and offers one action.

- **Counts strip:** needs you / running / done. "Done" means the turn ended OK in the last 30 min. The
  number is 20px and the word 16px.
- **Up to three lines.** If anything needs you, the lines are the needs, sorted by soonest `expiresAt`
  (a held step auto-denies then), then by longest wait. Otherwise they are the three most recently
  started running chats with their live label. Each line shows the chat title (`task || title`, the
  board's `titleOf`), the need's summary cut to six words, and its age. Tapping a line goes to
  `/?open=<sessionId>`. Overflow is shown as "· +N more" on the label row, because a row of its own
  under the list pushed the third line under the button.
- **One button: Pause all / Resume all.** It uses the Flow brake (`/api/agent/hold`, key
  `live:<sessionId>`) on every busy, un-held session. Pause has no confirm, because it only parks the
  next tool call and nothing is lost. Resume lets work run unattended again, so it needs a second tap,
  and that confirm lapses after 4s.
- **Deliberately absent:** transcript, composer, approve/deny. 360px can't show enough of a command to
  approve it safely.
- **Status by shape and motion:** a still solid ring means needs you, a turning dashed ring means
  running, two bars mean paused, ✓ means done. Under reduced motion the dashed ring stops turning, and
  the dash still tells it apart from the solid ring.
- **Polling:** `/api/agent/live` every 5s, only while the page is visible, and immediately on
  `visibilitychange`. If a poll fails the board stays up, the header says "offline", and the label
  says "Not updating" instead of "All quiet". Otherwise a dead poll and an idle box would look
  identical.

Two server additions came with it. `Need.since` (set when the pending call is created) records how
long a need has waited. Nothing else did: `expiresAt` exists only for held steps, and `phaseSince`
moves on every `touch()`. `/api/bento/sessions?ids=a,b` narrows the reply, because the unfiltered list
was 54 KB on the author's box and the glance needs about three titles.

**`useCoverScreen()`** (`lib/use-cover.ts`) is for the main page's redirect. It requires the viewport
to be ≤420×480 **and** `screen` to be that small. Viewport alone would also match a laptop window
dragged small, and a phone's main screen with the keyboard up (`resizes-content` shrinks the
viewport). Redirecting someone mid-typing would lose the screen they were on. Checked in Playwright:
cover 360×400 true; Flip main 412×960 false; 412×450 viewport on a 412×960 screen false; 400×450 window
on a laptop screen false.

**Getting it onto the Flex Window.** Samsung's own *Labs → Apps allowed on cover screen* is a short
allowlist (Messages, WhatsApp, YouTube, Maps…), and Chrome isn't on it. The route that works is Good
Lock → MultiStar → *I ♡ Galaxy Foldable* → **Launcher Widget**. Pick the apps, then add the Good Lock
Launcher widget under Settings → Cover screen → Widgets. That picker lists every installed app, and an
installed PWA (WebAPK) is its own app, so it should appear there. Press reports confirm Chrome works
this way; nobody has confirmed a WebAPK specifically. Not yet tried on the device. The installed app
opens at `start_url` (`/`), so either the main page redirects via `useCoverScreen()`, or you install a
second shortcut to `/glance`.

### Focus: the dock, the progress sheet, the N5 drawer — `components/Focus.tsx`, `lib/focus.ts`

Shipped 2026-10-06. It came from a pitch (`~/ecvision/pitches/minami-phone`, rounds 5–9) that three
designer agents (Android/foldables, messaging, agent-ops) critiqued and argued over for three rounds.
He asked for it: "go back and forth across chats to see progress", then "add and remove certain chats
out of the focus".

- **Focus is a pinned set of at most 5 session ids**, stored on the server (`~/.minami/focus.json`,
  `/api/agent/focus`) so the Flip, the N5 and the Mac share one dock. Before any pin exists, the dock
  falls back to recently visited chats, so it is never empty.
- **The dock (vertical phone)** replaces the old chat bar. It holds the current chat, one **visitor**
  (the most urgent chat *outside* focus that failed or needs you, dashed), two pins, "+N" and ☰. It
  never grows wider: each new mechanic wanted its own chip. The dock only switches chats; there is no
  long-press drag on it, because One UI's launcher owns that gesture at the bottom edge. Its sheet
  opens from the handle *above* the bar, so swiping up never triggers Android's home gesture.
- **The sheet** sorts by urgency, never by recency: failed, then needs you, running, new, idle. A
  running chat shows its plan step by name, as segments with an ETA that admits its age (a range
  once it is 30s stale). Pin is a visible ＋ because it is safe. Unpin is a swipe left because it is
  destructive, and a resting tap target gets hit by scroll flicks. Undo is offered on *remove*.
- **Full at 5:** a done pin steps out by itself, with Undo. The "Dock is full, swap out:" question
  appears only when all five pins are still active. A running or waiting chat is never evicted for you.
- **N5 unfolded (`split`) is a reading desk.** No dock and no 288px list next to the reply. A pill in
  the chat header opens the same sheet as a drawer from the left, and Back closes it. Claude's prose
  gets 17px at a 62ch measure (`.desk .msg-a` in `globals.css`). The pitch also put the composer in a
  side pane beside the reply; **not built yet**, because it means restructuring `ChatColumn`'s footer.
- **Not built yet from the pitch:** the keyboard-up quote strip (the picked option shown as two lines
  with "swap ▾"). It needs option-picking in the composer first.

### How to re-audit

There is no checked-in harness. The audit was two throwaway Playwright scripts (route × viewport
screenshots plus an overflow scan, then a touch walk-through of a pane), and the overflow scan was the
less useful half, for the reason above. What finds these bugs is a `hasTouch: true, isMobile: true`
context that **taps** through the panel: open a tile, switch tabs, open the slot, open the add menu.
Never type into a pane in such a run. A pane on a dev instance is a real session.
