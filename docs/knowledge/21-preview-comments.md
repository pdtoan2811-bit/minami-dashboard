# Preview comments — point at the running app, not at a screenshot

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

**Status: shipped 2026-09-21** (same day it was specified — twenty decisions in one discovery pass,
recorded below so the build doesn't re-litigate them). Verified end to end on a dev instance: a pin
on `/settings` reached a live session as an image block plus the structured text, and the session
answered with the component chain and selector it was given.

---

## 21. Preview comments — `app/preview/[session]`, `public/inspect.js`, `lib/preview-comments.ts`

### The problem
Every dashboard turn that changes UI ends the same way: Thomas opens the localhost app in a tab,
sees what's wrong, and then *describes* it to the pane — screenshots the error, types "the price on
the product card overflows", hopes the session finds the right component. The context Claude needs
(which element, which component, what the console said, what it looked like) is all sitting in that
browser tab and none of it reaches the chat except through prose. This is the "losing the thread"
bottleneck at the scale of a single turn.

The dashboard has no live view of the app at all. A `url` preview chip (§5c) opens a new tab;
the Browser panel (§5b) shows *Claude's* headless page, which cannot be clicked and is not your
state. So there is no surface where Thomas uses the app and points.

### The shape
A **pop-out preview window** that is a dashboard page wrapping the app in an iframe, bound to one
chat pane. Inside the app a **one-line dev script** (`inspect.js`, served by the dashboard) gives
the wrapper what a cross-origin iframe otherwise hides: the element under the cursor, its React
component chain, a DOM-rendered crop of the region, and the app's own console/network/Next.js
errors. Thomas drops **numbered pins** with a note and an optional intent, drags **rectangles** for
things that aren't one element, and presses **Send N comments** once. The bound pane receives one
structured user turn with thumbnails; the pop-out's status bar follows the turn and the pins fade
when it ends.

```
pop-out  /preview/<sessionId>?url=http://localhost:3001/products
┌───────────────────────────────────────────────────────────────────────┐
│ ← → ↻  localhost:3001/products   [Pin] [Rect] [Note] [Move]  ⚠2  Send 3 │  toolbar (dashboard React)
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│   <iframe src=url>   ← the real app, your login, your scroll          │
│      ① ProductCard > PriceTag  "overflows on long names"  Fix         │  pins drawn by the wrapper,
│      ② ▭ 412×80 "too much gap here"  Style                            │  positioned from rects the
│                                                                       │  script reports
├───────────────────────────────────────────────────────────────────────┤
│ ● chat-4 · Claude is editing components/ProductCard.tsx…   → open pane │  status bar (SSE)
└───────────────────────────────────────────────────────────────────────┘
```

### Mechanics

**Two origins, one channel.** The wrapper is `localhost:3000`; the app is another port, so the
wrapper cannot touch its DOM. `inspect.js` runs inside the app and talks to `window.parent` with
`postMessage`. Every frame carries `tag: "minami-inspect"` and both sides ignore anything else.
The script does NOT read the dashboard's origin from its own `src` (a relative src would give the
app's origin): it learns it from the handshake — the wrapper's `connect` — and from then on pins
every outgoing message to that origin, accepting only loopback hostnames. Before `connect`, only
`hello` may leave the page; anything else would be a broadcast of the DOM to whoever framed it. There is no proxy
and no HTML rewriting: Next.js dev servers with HMR websockets do not survive being proxied, and
the apps being previewed are Thomas's own, so one line in a root layout is cheaper than a proxy
that is wrong on Tuesdays.

**The script is a broadcaster, not a UI.** It draws nothing but the hover highlight and the pin
markers the wrapper asks for; all toolbar/state lives in the wrapper so an app reload (HMR,
navigation, Claude's fix landing) cannot wipe it. It announces itself (`hello` with URL, title,
viewport) when it runs and again on every URL/title change (App Router soft navigations fire no
`popstate`, so the href is polled and `<head>` observed).

> 🐛 **The handshake races in both directions, and the first build lost both.** The script's
> `hello` fires at parse time — before the iframe's `load` event, by many seconds on a slow dev
> compile — so v1's "reset `hooked` on load and wait for a hello" marked a hooked page as unhooked.
> And on a fresh navigation the iframe (already in the SSR HTML) greets an empty room: React hasn't
> hydrated the wrapper's message listener yet, so nobody answers with `connect` and the script stays
> unpinned, dropping every later command. The fix is that the wrapper never waits to be greeted: it
> **probes** (`connect` + `ping`, both idempotent in the script) when its listener mounts AND on every
> frame load, and judges presence by whether a `hello` comes back within 1.5s. If none does, the
> toolbar shows **Enable comments** (see below).

**Hotkeys reach whichever document has focus** — and after any click in the app, that is the app,
not the wrapper. So the script mirrors the wrapper's shortcuts (P · R · M · N · Esc · ⌘↩) and
forwards them as `key` messages when nothing editable has focus; the wrapper owns the tool state
either way. Without the relay, P silently stopped working the moment you used the page.

**What a pin captures** (`inspect.js` → `pin` message):
- `selector` — shortest unique CSS path (id › data-testid › `tag.class` chain, `nth-of-type` only
  where siblings are ambiguous), for re-anchoring and for Claude's Playwright to re-shoot. Ids
  from `useId`/Radix/MUI and Tailwind-arbitrary or CSS-module classes are skipped: they change
  between renders, so a selector built on them fails to re-anchor after the very reload it exists
  to survive.
- `components` — the React owner chain read from the element's `__reactFiber$*` key, walking
  `return` and keeping named function/class components (`ProductGrid > ProductCard > PriceTag`).
  Empty for non-React pages (the studios), and that is fine: selector + text still locate it.
  Deliberately **no** build-time `data-source` plugin (Q9): component names are enough for Claude
  to grep, and zero config per app is what makes this work in every folder.
- `text` — trimmed `innerText`, capped at 200 chars.
- `rect` — bounding box in iframe coordinates, plus scroll offsets, so the wrapper can draw the
  marker over the iframe and re-place it on `scroll`/`resize` (the script re-sends rects for all
  live pins on those events, throttled).
- `crop` — a PNG of `rect` padded by 24px, rendered in-page with `html-to-image` (bundled into
  `inspect.js`). It is what Thomas sees — his session, his scroll — at the price that cross-origin
  images and canvases may come out blank. Chosen over Playwright re-shooting (Q10) because
  Claude's browser is logged out and unscrolled; Playwright is used *after* the fix instead (Q19).

**Rectangle and the other marks** (Q12): a `rect` mark asks the script for every element whose box
intersects the drag (capped, deduped by component) plus a crop of the region. A **whole-page note**
is a pin with no anchor. **Move** is two clicks: source element, destination element — one pin with
`from`/`to`. Freehand drawing was declined.

**Comment mode, not a Pin button** (first-use feedback, 2026-09-21). v1 made you arm "Pin" for
every comment and disarmed after each pick, and reopening a note meant finding it in the tray. Both
read as "not intuitive" on first contact with a real app. Now the pop-out **opens in Comment mode**:
click anything and its note opens on it; click the next thing and you're on the next comment (an
untouched note is dropped, not left as a blank pin — that is what made "stay armed" safe). The
markers inside the app are **clickable** and reopen their note, in either mode; under the armed
overlay the script hit-tests through to the badge so a click on ① never drops a ② on top of it.
**Esc is layered** — close the note (keeping it), then cancel a half-done move, then leave Comment
for **Browse**, where the app works normally. The disarm message is no longer gated on the
handshake state: a disarm that waits for `hooked` can leave the crosshair stuck over the app.

**Pins persist across reloads** (Q7): the wrapper keeps `pins[]` in its own React state; after
every `hello` (i.e. every app load) and every scroll it sends `anchor` with the selectors and the
script replies `anchored` with a fresh box per selector, or `null` for one that no longer resolves.
A gone pin keeps its note and is sent as "element no longer on the page" — Claude may have removed
it on purpose, and the note is still worth sending. Markers are drawn *inside* the app (so they
scroll with it) from the wrapper's list; the tool disarms after each pick, because a crosshair
left armed turns the next click on the page — to scroll, to focus — into a stray pin.

**Errors ride along and can be sent alone** (Q15, Q16). The script hooks `console.error`,
`window.onerror`, `unhandledrejection`, and wraps `fetch`/`XMLHttpRequest` to record non-2xx and
network failures; it also watches for the Next.js error overlay (`nextjs-portal` shadow root) and
lifts its message + file verbatim. Each entry is `{ts, kind, message, firstFrame}`; the buffer is
sent with every batch and cleared on send. The toolbar shows a red badge with the count; clicking
it composes an errors-only message. **Nothing auto-sends** — a chatty error loop burns turns and
trust at once.

**Sending is one user turn** (Q4, Q17). The wrapper uploads each crop through the existing
`POST /api/fs/paste` (§11 — the path is the payload, survives reload) and then calls
`POST /api/agent/send` for the bound session with a message the session can act on directly:

```
[Preview comments] http://localhost:3001/products · 1440×900 · 3 pins

① Fix — "price overflows on long product names"
   ProductGrid > ProductCard > PriceTag · `div.card:nth-of-type(3) > span.price`
   text: "$1,299.00" · 88×20 @ (412,310)
   /Users/thomas/.minami/pastes/pin-1.png

② Style — "too much gap between filter bar and grid"
   region 1180×80 @ (130,220) containing FilterBar, ProductGrid
   /Users/thomas/.minami/pastes/pin-2.png

③ Move — "put the sort dropdown here"
   from SortSelect `select#sort` → to FilterBar `div.filters > div:last-child`

Errors since last send (1):
  TypeError: Cannot read properties of undefined (reading 'map') — ProductGrid.tsx:42

After making the changes, open the same URL in the browser tool and screenshot each pinned
selector; show before/after for each pin in your reply.
```

The last paragraph is the Q19 self-verify nudge; it is appended by the wrapper, not the manager,
so it costs nothing on turns that aren't pin batches. Intent chips (Q11: Fix · Style · Move ·
Remove · Ask · Copy) become the word after the number — a `Style` pin tells the session no logic
should change.

**Binding** (Q6): the pop-out is opened from the pane — a "Comment on preview" action on each
`url` chip and in the pane header — with `sessionId` and `cwd` in the URL, so it is bound before
it exists. The status bar names the pane and offers a switcher over live sessions for re-binding;
the auto-by-cwd option was declined as "zero clicks, occasionally wrong".

**Status bar** (Q18): subscribes to the same `/api/agent/stream` SSE the pane uses and shows the
activity label (§3) while the turn runs, then the first line of the reply. Pins go grey on send and
fade when the `result` event arrives (Q8), so the next reload shows the clean result. No mini-chat
in the pop-out — "click to jump to the pane" is enough.

**Enable comments** (Q14): when no `hello` arrives, the toolbar shows one button that sends the
bound session a precise instruction — add
`{process.env.NODE_ENV === "development" && <script src="http://localhost:3000/inspect.js" />}`
to the root layout (or the equivalent for a non-Next app) — and the session makes the edit.
Manual copy of the snippet stays available for repos Claude shouldn't touch. No auto-injecting
proxy.

**Targets** (Q13): Next.js/React dev servers and the static studios (Kit, Deck, Guide). Shopify
embedded apps are out of scope — they render inside `admin.shopify.com`, which cannot be framed;
if that need materialises, the fallback is the script drawing its own toolbar in the app tab
(the Q5 option that was declined for v1).

### First contact with a real app — what it broke, and why (2026-09-22)

Pointed at ecvision (`localhost:3150`, a Next.js app with an app-shell layout), the feature was
reported as "buggy as hell". A drive-through plus two adversarial code audits found the causes; the
individual post-mortems sit next to the code they belong to, and this is the shape of them.

**The overlay was the root of most of it.** Picking was implemented as a full-viewport `fixed`
layer that swallowed every pointer event. Measured against a real inner scroll container: armed, a
wheel gave `inner 0 / window 150` — the panel you were trying to comment on didn't move and the
page behind it did. `:hover` never fired either, so dropdowns, tooltips and row actions could not
be made to appear: an entire class of UI was un-commentable, in the mode the window opens in. The
layer is gone. Picking now listens on the document in the **capture phase** and the highlight is
`pointer-events:none`, so hover and scroll behave exactly as they do without the script and only
the click itself is intercepted. `composedPath()[0]` is used for the target, which also makes
content inside web components pickable for the first time.

**Crops were rendering the whole page.** `html-to-image` was pointed at `document.body`, then cut.
On ecvision's 1280×4363 home page that measured **19.4s** (another run: 28.9s on a 6,053-node
page), against a 4s timeout that *could not fire* — the render starves its own `setTimeout`, so the
guard ran at 14.7s. Every crop was null, every click froze the app for ~15s, and nothing serialised
picks, so three clicks queued 37s of jank. Worse, on an app-shell layout (`html,body{overflow:hidden}`
with a scrolling `<div>` — most Next dashboards) the body-cut produced a picture of *a different
part of the page*: measured zero matching pixels. Crops are now scoped to the **subject** — the
picked element, or the nearest ancestor that still fits on screen when the element is a sliver —
which is both fast and correct under any scroller. Measured after: pin in **756ms**, crop in
**1.0s**.

**And the pin waited for its picture.** `picked` was only posted once the render settled, so a
click did nothing visible for as long as the crop took. The pin is posted immediately now and the
thumbnail arrives later as `cropped`, matched by `reqId`.

> 🐛 Others fixed in the same pass, each with its post-mortem at the code: the note editor clamped
> only its top edge, so any pin in the lower third opened a card whose textarea and buttons were
> below the stage's hidden overflow — unreachable, and Esc deleted the pin because the note was
> still empty (it now measures itself and flips above the element); `⌘↩` was dead from inside the
> note (the window handler bails on a focused input) and Enter merely closed it; Back/Forward
> called `history.go()` on a cross-origin frame, which throws, so they were dead buttons while
> Reload silently reverted to the original URL (the wrapper keeps its own history of the pages the
> script reports); rebinding the window left the old session's `EventSource` open, so the pop-out
> reported — and routed sends by — the *previous* chat's state (it reloads now); markers rebuilt
> their entire layer on every push (~8×/s while scrolling), destroying badges under the cursor, and
> a rect marker re-based its document coordinates every frame so it drifted away from what it
> marked; a marker on a hidden element parked at (-11,-11) forever because `display:none` reports a
> 0×0 box at the origin; `selectorFor` gave up at depth 8 and returned a **non-unique** selector
> (measured: two different spans, same selector) — it now walks as far as needed and reports
> `ambiguous: N` rather than lying; sent pins stayed grey forever if the next turn started within
> 1.5s; a batch spanning two pages was reported under one URL; the note open at send time was
> included even when empty; and `console.error` was patched, which re-attributed every one of the
> app's own errors to `inspect-core.js` in DevTools and counted React's dev warnings as errors —
> the patch is gone entirely, since real faults arrive via `error`/`unhandledrejection`/network/the
> Next overlay anyway. Aborted requests are no longer reported as failures, `typing()` sees into
> shadow roots, and the relayed `⌘↩` no longer calls `preventDefault` on the host app's key.

**The lesson worth keeping:** every one of these is a cost paid by *the app being previewed*, not
by the dashboard — a blocked wheel, a stolen shortcut, a frozen main thread, a rewritten console.
A tool that watches someone else's app has to be judged by what it costs that app when it is
merely *present*, and none of that shows up in the dashboard's own tests.

### What shipped (Q20: everything above, one build)
- `public/inspect-core.js` — the in-app script (hello · hover · pick · region · anchor · markers ·
  crop · errors · key relay), plain ES2019, no build step. Served as **`/inspect.js`** by
  `app/inspect.js/route.ts`, which prepends the vendored `public/vendor/html-to-image.js` (MIT,
  v1.11.13, copied verbatim) at request time. Vendored rather than an npm dependency read from
  `node_modules` because nothing in this box's pipeline installs — `task.mjs merge` and `deploy.sh`
  build and swap, worktrees share only git objects (§9) — so the first version would have shipped
  a server whose every crop was null. If the file is ever missing the script still loads; only the
  crop degrades to `null`.
- `lib/preview-comments.ts` — the typed protocol (the script's twin; change both), the `Pin`
  model, `composeMessage` / `composeErrorsOnly`, `installSnippet`, `isPreviewUrl`.
- `app/preview/[session]/page.tsx` — the pop-out: toolbar, iframe, note editor with intent chips,
  pin tray, status bar over the same `useAgent` hook the pane uses (key `live:<sid>` is the
  server's own alias for every session, so the pop-out and the pane hit one `Session`), the
  rebind switcher over `/api/agent/live`, Enable-comments, and Send through `/api/fs/paste` +
  `/api/agent/send` (queued if the session is mid-turn).
- Entry points in `app/page.tsx`: a `MessageSquarePlus` beside every localhost preview chip, and
  the same icon in the pane header once a localhost preview has appeared in the conversation.
- `app/layout.tsx` includes `/inspect.js` in development, so a dev instance of the dashboard is
  itself a preview target — which is how this was tested.
- The pane sees the pop-out's send as `busy` + streamed deltas and reconciles the user turn (with
  its thumbnail) from disk at `result` — the §11 path, nothing new.

Not done: a §5b nudge so the verify screenshots land in the pane's browser panel (they do already
when the session uses `browser_take_screenshot` without a filename).

### Why not…
- **An iframe tab in the side slot** — declined (Q1); the pane is already most of the viewport and
  the app deserves its own window. The pop-out is a dashboard page, so a side-slot tab can wrap the
  same component later without redoing anything.
- **Claude's Chrome extension / a real browser** — Claude Code's integration drives *your* Chrome
  and ships no viewport UI (§5b); it solves Claude looking, not you pointing.
- **Vercel Toolbar-style injected UI** — the toolbar state would live inside the app and die on
  every reload; the wrapper owns it instead.
