# The shell — panel, panes, density, bento

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 5e. The shell — `app/page.tsx`, `components/BentoRail.tsx`, `components/Composer.tsx`, `lib/density.ts`

### Density tiers — chrome is rationed by measured room, not by breakpoint

Four chats in one panel is the layout this app exists for, and it was the layout it was worst at.
Measured on a 1455×820 window with the bento railed, each pane came to ~689×354 CSS px, of which
**chrome took ~200px**: header 46 (two lines — title *and* goal), flow strip 42, mode row 34, composer
50, padding 24. The transcript — the only reason the pane is open — got **146px, about three lines**.

`lib/density.ts` measures a box with `ResizeObserver` and names the result: **roomy · snug · tight ·
micro**. Everything inside reads that one name.

- **Media queries cannot express this.** None of it is about the *window*: the same 27" display gives a
  roomy pane at one chat and a cramped one at four, and dragging the divider changes it again with no
  breakpoint firing. Container queries get closer, but half of what has to give way is a decision about
  *what to render at all* — a control row folding into one pill, a side panel that must not open — not
  about styling something that renders anyway. `FilePanel`/`BrowserPanel` still use `@container` for
  their own width, and correctly: that part *is* pure CSS.
- **Both axes, tightest wins.** A pane can be 900px wide and still hold two lines of transcript. Height
  is the axis that hurts; width mostly decides whether a control row fits on one line.
- **Growing back costs +28px of hysteresis.** Without it a box parked on a threshold oscillates:
  showing a control row shortens the transcript, which can push the box back under the line that
  revealed it. Same one-way-hysteresis discipline as the divider's 260/170 snap above. Shrinking is
  immediate — overflowing chrome is a visible bug, and half a second of it is worse than an eager
  reflow.
- **A `display:none` box measures 0×0 and is ignored**, or every collapsed pane (see focus mode below)
  would demote to `micro` and re-promote on reveal.

What each tier gives up, in order: the header's **goal subtitle** (the pane's category — true all
session, read once, and the tab strip and bento tile both still say it) → **the mode row folds into a
`code · bypass` pill** → padding and gaps → at `micro`, the utility bar itself, the project icon and the
📎. Net effect at four panes: **transcript 146px → ~232px**.

**The flow strip is no longer part of that ladder — it is a chip at every tier.** It used to have a
full-width form that took its own row (~42px with its margin) and folded to a chip only when cramped,
which was affordable while the 2×2 grid was the default view: the wide form only appeared in a large
pane. Tabs-first inverted that. The pane you are reading is now *always* `roomy`, so "the roomy
treatment" stopped meaning "occasionally" and started meaning "always" — a permanent row, in every pane,
for a label. The chip sits on the control row beside Plan/Code and the approval chips, and the wide
variant is deleted rather than left unreachable.

The one thing the wide form carried that the chip can't is `detail`, the running step's title. That is
already said by the activity line at the other end of the same row, so it moved to the tooltip instead
of being lost, and the chip's label tints while a step is in progress. The rule this control must not
break is still met: **the door is visible at rest** — v1's only appeared on hover, on a tile, in another
view, which is the whole reason nobody found it.

**The folded pill and the full row are one component** (`ModeControls`). The approval level is the most
dangerous thing in this UI to be wrong about — two renderings of it, drifting, is the failure worth
spending a component to make impossible. `PERM_LABEL` exists for the same reason: one spelling of
"bypass". Held and bypass keep their colour even folded, because what survives a fold must still be
readable at a glance.

### Embody — the pane you're typing in gets a tier back

`dc = composing ? looser(d) : d`. Focus the composer and the pane spends one tier more: the folded pill
unfolds into the real Plan/Code and approval controls. That is the one moment before Enter when the
mode is the thing you most need to see, and the moment you are demonstrably not reading the transcript.

- **Focus, not hover.** Hover fires on the way to somewhere else; a control row that flickers past the
  cursor is worse than one that stays folded.
- **Scoped to the composer row, not the whole footer.** The mode pill sits *outside* it deliberately —
  inside, clicking the pill would expand the footer out from under its own popover, which is exactly
  what the first revision did (the popover state was set and the compact branch it lived in had already
  been swapped away).
- **`onBlurCapture` tests `relatedTarget`**, or tabbing from the textarea to the send button beside it
  collapses the controls mid-gesture and moves that button out from under the cursor.
- **The composer's max height is a share of the pane** (`MAX_H` per tier, 220 → 72). 220px is right in a
  full-width pane and a catastrophe in a 250px one: a fifteen-line draft grew over the entire
  conversation, so you were typing a message about a reply you could no longer see. This is the one
  consumer of `DensityContext` — a leaf that can't take the tier as a prop and is rationing the *pane's*
  height, not its own width.

### Tabs is the default view; the grid is the alternate

The first cut had this the other way round — grid at rest, one pane promotable out of it — and that was
the wrong default for the same reason the chrome had to fold: four transcripts at once is a glanceable
state, not a readable one. The resting state should be the one you can *read*.

- **One view switch for the panel, not a maximise button per pane.** The per-pane ⤢ asked "do you want
  THIS one bigger?" once per pane, when the decision is made once for the whole panel. The switch lives
  in the tab row; the tab itself is how you choose a pane. What stayed per-pane is ✕, which genuinely is
  — and it has since moved onto the tab as well; see "Closing a tab" below.
- **The tabs render in both views.** In grid view none is lit, and clicking one is how you drop back into
  reading that pane. One row that never moves beats two rows that swap places.
- **`Escape` closes the panel again, unconditionally.** It briefly meant "step out of focus first", which
  was right while focus was a mode you could get stuck in. With tabs as the resting state there's nothing
  to step out of, so the key and the label on the button (`esc ✕`) agree again.
- **`focusPane` is derived and clamped in the render**, not stored: `paneView === "tabs" ? min(activePane,
  panes.length - 1) : null`. Storing it meant a close could leave it pointing past the array for the one
  render before its effect ran.
- **Grid view is tighter than tabs view** (`gap-1 p-1` vs `gap-2 p-2`). Grid exists to show all four at
  once, so every px of gap is px not spent on the thing it's for — 8px gaps plus 8px of panel padding
  cost ~24px of each column in a 2×2, about a line of transcript per pane, spent on air.

### Closing a tab — the browser's affordances, minus the browser's meaning

Closing used to be one ✕ inside the pane's own header, shown only at `count > 1`. That is where a close
button goes in a window manager, not where anyone looks for it after twenty years of browser tabs. The
tab strip now carries the whole set: **✕ on the tab, middle-click, ⌥W to close, ⌥⇧T to reopen.**

The analogy stops at what "close" *means*. A browser tab is the session; closing it ends it. Here the
tab is a *view* of a session that lives in the server process, so closing a pane only unsubscribes it —
the turn keeps running, the session stays on the bento board and in the ＋ menu, and `manager.ts` only
reaps it after `IDLE_REAP_MS` with no listeners. Every close tooltip says "the session keeps running",
because a one-keystroke close is only safe if that's legible before you press it.

- **The tab is a `div` wrapping two buttons**, not a button with a nested ✕. A button inside a button is
  invalid HTML and the browser's recovery is to drop the inner one — the close target would have
  selected the tab instead of closing it.
- **The ✕ is always rendered, only sometimes visible** (`opacity-0 group-hover/tab:opacity-100`, always
  on for the active tab). Revealing it on hover alone widens the tab at the moment you reach for it and
  slides the label out from under the cursor — the same mis-click that moved the header peek below this
  row. Reserving the width costs 18px per tab, at a hard maximum of four.
- **Middle-click closes on `mousedown`, not `auxclick`.** By the time `auxclick` fires the middle button
  has already armed the scroll-anchor cursor, so it's too late to `preventDefault` it.
- **⌥W and ⌥⇧T, not ⌘W/⌘⇧T.** Chrome reserves the ⌘ pair for its own tabs and won't yield them to a
  page; a shortcut that sometimes closes the whole dashboard is worse than no shortcut. ⌥ also puts
  them in the same family as ⌥1–4/⌥0. Keyed off `e.code`, since ⌥W emits "∑" on a Mac layout, and bound
  ahead of the composer guard like the digit chords — a draft is keyed by session (or pane key, when
  blank), so ⌥⇧T brings the pane back with what you were typing still in it.
- **The reopen stack is per-panel and bounded to 8**, cleared whenever the panel closes or another topic
  opens, so ⌥⇧T can't drop a chat from a project you left into the one you're in. It skips entries whose
  session is already back on screen: two panes on one session id would share a draft key and a live
  subscription and fight over both. A restored tab goes back at its original index — one that lands
  somewhere new isn't an undo.
- **The last tab takes the panel with it**, the way the last browser tab takes the window. The
  alternative is panel chrome with nothing under it, which isn't a state you can read.

> 🐛 **Closing a tab could silently swap which conversation you were reading.** `activePane` is an index
> into `panes`, and the only thing correcting it after a close was the clamp `min(activePane,
> panes.length - 1)`. That clamp knows the array got *shorter*; it does not know *which end* lost an
> element. Closing a tab to the left of the active one shifts every later index down by one, so the
> stored index kept pointing at the same slot and that slot now held a different chat: with four panes
> open and pane 2 active, closing pane 1 left the panel reading pane 3's transcript while the tab strip
> was lit correctly. It looked right in most tests because the arithmetic happens to agree whenever the
> active tab is the last one — the case you reach for first.
>
> Closing now decrements explicitly (`setActivePane(a => (i < a ? a - 1 : a))`) so the *same
> conversation* keeps focus; closing the active tab itself keeps the index, which lands on its
> right-hand neighbour and clamps back if it was last, matching every browser. The clamp effect stays as
> the backstop for the render between a close and its effect. All three close paths — the tab ✕, the
> in-pane ✕ and ⌥W — route through one `closePane(i)`, so they can't disagree about this again.

### A tab that's working has to say so from the corner of your eye

An unfocused pane is `display:none`, so its own activity line — phase, elapsed, tool — is unreadable
while it runs. **The tab strip is the only surface a background turn has**, and for a long time it
spent that surface on a single 6px sakura dot with Tailwind's `animate-pulse`. Three things were
wrong with that, and they're separable:

- **Brightness is the wrong channel.** `animate-pulse` fades opacity; at the dim end of its cycle a
  6px dot is indistinguishable from one that isn't animating, so "is that tab running?" took a
  second of staring. The dot now holds full opacity and emits an **expanding ring**
  (`.tab-live-ring`, `globals.css`) — motion at the shape's *edge*, which peripheral vision resolves
  far better than a brightness change, for the same one composited transform.
- **The tab itself stayed grey.** An unfocused tab is `text-neutral-500` on a hairline border, i.e.
  it reads as disabled — wrong for the one mid-turn. A running tab now takes a **phase-tinted border
  and wash** (`color-mix`, not an `#rrggbbaa` concat: `PHASE_TINT.thinking` is `var(--sakura)`, and
  appending alpha to a `var()` yields an invalid colour that silently drops the border). The focused
  tab keeps sakura regardless — "which am I reading" must never be outshouted by "which is working".
- **The signal was binary** where the data wasn't. `liveAct` carries `phase`, and the tile has used
  it for ages; the tab threw it away. Colour now carries thinking / tool / responding / retrying, so
  the row answers *what* it's doing, not just *that* it is.

Two rules the indicator inherits rather than invents:

- **The dot slot is always rendered**, dim grey at rest. Mounting it on the first busy frame shifted
  the label 12px sideways every time a turn started or ended — on the tab you were about to click,
  the same class of mis-click as the header peek and the hover-revealed ✕.
- **`awaiting` gets the loudest colour and no motion**, matching `.activity-idle`. Animating next to
  "waiting for your approval" claims work is happening when nothing moves until you click.

**The ring alone was still a six-pixel answer.** It works once you are looking at the dot, and the
whole premise of this indicator is that you are *not* — you are reading another transcript, and in
grid view the dot is one of a dozen small round things. So a running tab also gets an indeterminate
**sweep** along its foot (`.tab-run-sweep`): a phase-tinted bar the width of the tab, travelling. It
is the shape peripheral vision finds without being aimed, and it borrows the meaning every progress
bar has already taught. Two elements, because the track has to clip the runner — clipped on the
sweep rather than on the tab, which would also crop the ring, and the ring is *supposed* to bleed
past the tab's rounded edge. Under `prefers-reduced-motion` the runner is dropped and the track keeps
the tint: a static underline still marks the running tab, which is the information.

Only a genuinely running turn animates, and both `.tab-live-ring` and the sweep are in the
`prefers-reduced-motion` kill list — at rest the strip attaches no animation at all, which is the
same bargain the bento tiles make. A second animation on a tab that is *already* animating is close
to free; §12's measurement is that the frame loop, not its contents, is the cost.

### Selection is a fill and a tail, not a colour

> 🐛 **"Which tab am I reading" became unreadable, and colour could not fix it.** Selection and
> activity were both drawn with a border colour and a background wash — two orthogonal facts sharing
> two channels, so the tab could only ever express one of them. They also shared a *hue*:
> `PHASE_TINT.thinking` is literally `var(--sakura)`, the accent selection uses, and `TOOL_TINT.exec`
> and `.ask` are that same pink again. So the numbers came out at **selected = sakura @60% border /
> 10% wash** against **thinking = sakura @55% / 9%**. Five percent of border alpha is not a
> distinction. Adding the running sweep made it worse rather than better: the loudest tab in the row
> was no longer the one you were reading.
>
> Recolouring the phase map was the wrong lever — those tints are shared with the tiles, the tool
> chips and the transcript blocks, and any new accent would collide again. Selection moved **off
> colour** instead:
>
> - **Fill means selected. Tint means working.** The selected tab is the only FILLED one
>   (`bg-[var(--sakura)]/[0.18]`, full-strength border); a running tab is outlined and tinted and now
>   carries **no background wash at all**. Filled versus outlined survives any hue collision.
> - **A tail under the selected tab** (`.tab-caret`), pointing down at the transcript it belongs to.
>   Shape is a channel nothing else in the row uses. Border-triangle, not a rotated square: a rotated
>   square needs a background to hide its inner half, and that background is exactly the thing that
>   changes with selection and phase.
> - The `⌥N` badge goes sakura on the selected tab too — dim grey on the tab you are reading was the
>   same "reads as disabled" problem the running tint was introduced to solve.
>
> The tail hangs 5px below the tab's border box, which is why the row's vertical padding now lives on
> the **scroll container** rather than the row: `overflow-x-auto` clips at the padding box, so that
> padding is the only room the tail can occupy. Symmetric, so `items-center` still lines the tabs up
> with the ＋/esc controls, and the row's height is unchanged.
> *Reported by user: "chat panel tab are being chosen need an indicator something like a triangle
> arrow since the color clues are not really intuitive anymore".*

### Which tab you land on, and in what order

Both are decided **only when a topic opens** — `openProject`, `app/page.tsx`. Nothing re-sorts the row
or moves the selection while you are in it, and that restraint is the design, not an omission: a tab
that reorders itself under the cursor is the mis-click the header peek used to cause, and switching
the panel to a background chat that just started a turn would take the transcript you are reading off
screen mid-sentence. While you are in a topic, a working tab announces itself and stays put — that is
what the ring and the sweep are for.

- **The row is sorted newest-interaction-first.** Remembered panes (`openPanes`, per topic) used to
  come back in insertion order, so a chat added through ＋ months ago sat at ⌥1 forever while the one
  you actually work in was ⌥4.
- **A remembered *blank* pane sorts last.** It is a scratch pad you kept; landing the panel on an empty
  composer is exactly the "the chat was thrown away" shape the `allBlank` guard above exists to prevent.
- **Recency is read from the raw session list, via a ref.** Not `p.sessions` and not `pool`: both are
  filtered (trivial, then the date window), and a pane the user chose to keep open may be neither. Read
  through a filtered list, every such pane dated to `0` and swept to the end of the row. The ref exists
  because `openProject` is the onClick of every tile — depending on `sessions` or `liveAct` directly
  would rebuild it, and re-render the whole board, on every poll.
- **Running outranks recent for the selection.** `lastActivity` comes off the transcript on disk, and a
  session mid-turn may not have written a line for a minute, so the chat that is *working* can easily
  sort below one you merely opened more recently — and it is the one you crossed the board to look at.

> 🐛 **Opening a topic landed you on a tab chosen by the topic you left.** `activePane` is panel-scoped
> state that outlives a project switch, and `openProject` never touched it — so arriving anywhere put
> you on whatever *index* you had been reading, clamped. Reading tab 4 of one project and clicking
> another tile opened that project's fourth chat, or its first by luck. An index carried across
> identities is not a selection. `openProject` and `startTopic` now both set it explicitly.
> *Reported by user: "auto open and sort tab with recent interaction when navigate across tiles".*

**`paneAct` — the gap `liveAct` cannot cover.** `liveAct` is keyed by *session id*, and a blank chat
has none until the server assigns one a second or two into its first turn. So the freshly-sent pane —
exactly the one you're watching — was missing from the map and its tab showed nothing. Each
`ChatColumn` now reports its own SSE-derived phase up via `onBusy` into `paneAct` (keyed by pane key,
pruned when the pane closes), and the strip reads it **only where `liveAct` has no entry**. That
ordering is the point: the server stays the single source of truth everywhere it has an answer, so
the two can't disagree — this is a fallback, not a second derivation. Measured on a blank pane: ring
and phase tint appear while the tab still reads "New chat", then the session id lands and `liveAct`
takes over mid-turn with no visible transition.

### The panel header hides, and comes back on hover

The identity header — icon, project name, repo path, tech icons, counts — is read once a session and
then holds ~46px forever. It collapses to nothing and slides back on hover, keyboard focus, or a pin.

- **`grid-rows-[0fr]` → `[1fr]`, not `max-height`.** It animates to the content's real height, so the
  header can't be clipped by a guessed maximum nor leave dead space under a short one.
- **The hover target is the whole chrome block**, header *and* tab row, as one `group`. Aiming at a
  0px-tall element would be a joke; the tab row sits directly beneath and is always there.
- **Pinning is the escape hatch**, persisted. Auto-hiding chrome is only tolerable if you can stop it —
  "I'm reading this repo path and it keeps sliding away" is the failure mode that makes people hate it.
- **`pr-14` moved to the tab row too.** The notification bell is fixed to the viewport's top-right, and
  with the header collapsed the tab row is what's under it.

> 🐛 **The add-chat menu opened with its first row already unclickable.** The `＋` dropdown is a
> *descendant* of `group/chrome`, so moving the pointer onto it counts as hovering the chrome and
> unfurls the peek — and the peek is `absolute inset-x-0 top-full z-20` while the menu was
> `absolute right-0 top-full z-20`. Equal `z-index`, and the peek comes later in DOM order, so it
> painted over the menu's top **57px**: measured `overlapPx: 57`, with the topmost element at 20px into
> the menu belonging to the header, not the list. That top row is "New blank chat", the most-used item.
>
> Two changes, because either alone leaves something wrong. The menu is now `z-30` so the stacking is
> correct whatever hovers; and the peek's `group-hover`/`group-focus-within` variants are dropped while
> `addMenu` is open, because a peek unfurling *behind* the list you deliberately opened is noise even
> when it isn't occluding. The click-away backdrop went `z-10` → `z-20` so it still sits above the peek.
> Verified: `overlapPx` 57 → 0, every probe point inside the menu owned by the menu, and the peek still
> opens to 57px with title, repo and icons once the menu is closed.

### Focus mode — four panes is a glanceable state, not a readable one

`⌥1–4` (or the pane's ⤢) gives one pane the whole panel; the other three fold into a tab strip that
keeps their live phase dot. `Esc` steps back to the grid, `⌥0` or ⊞ grid likewise.

- **The collapsed panes are `display:none`, never unmounted.** Unmounting would tear down four live
  `EventSource`s and their streamed turns every time you zoom into one. `ChatColumn`'s React key already
  documents that a remount mid-stream is a bug, not a nicety.
- **…which means saving and restoring `scrollTop` by hand.** A `display:none` box has no layout and the
  browser does not restore its scroll offset when it returns. Left alone, every trip in and out dumped
  the other three at the top of their rendered window *and* unpinned them, because `atBottom()` then
  reads false. `pinned` wins over the saved offset on the way back in — a pane that was following the
  reply has almost certainly grown while it was hidden.
- **`Escape` is layered, innermost first.** It used to close the whole panel unconditionally, which from
  a focused pane would throw away the panel to undo a zoom.
- **`e.code`, not `e.key`, for the chord.** Option+1 on a Mac layout produces `¡`, and on a Vietnamese
  layout something else again. The physical key is the only stable name. It fires while the composer has
  focus on purpose: switching panes mid-draft is the point, and drafts are persisted per session.
- **Focus is an index into `panes`**, so it's re-clamped whenever that array changes — closing the
  focused pane would otherwise leave the panel showing a different conversation than the one zoomed in.
- **A focused pane is `roomy`, so its side slot opens on its own.** Below `snug` the browser/file slot
  doesn't open at all: a preview docked beside a 380px transcript is two unreadable columns instead of
  one readable one. The header's reopen button then reads "expand this chat to show…" and *takes* the
  room rather than pretending there is some. Nothing is silently dropped — the button still carries the
  error/file count.
- **Crossing into 3+ panes auto-rails the bento, latched.** Un-rail it by hand at three panes and it
  stays un-railed until you drop under three and come back up. The heuristic never outlives an explicit
  choice.

### The bento collapses to a rail, it doesn't just shrink
Dragging the chat panel out to 85–90% leaves no room for a 3-column grid — but there's still room for
*navigation*, and losing the project switcher entirely is what forces you to drag the divider back and
forth all day. So past a threshold the grid changes **state** rather than size: a 56px vertical rail of
project chips.

The rail is the same information at a lower resolution, not a different widget. Every encoding the
tiles use is preserved: opacity is the same recency decay, plus the project accent, the live/review/
recent dot, and a pulsing ring for a folder with a live dashboard run.

**Chip height is a share of the measured column height**, so the strip is always exactly full — which
is why it's measured (`ResizeObserver`) rather than assumed: the height changes with the window and
with whether a chat panel is even open. Raw weight can't drive that share directly. `weight` is
`reqs + tokens/5000`, which spans three orders of magnitude across real projects — a busy repo is
~360× a fresh one — so proportional heights would render everything except the biggest as a 2px
sliver. `log1p` compression keeps the ordering and the *sense* of relative size (~3× across that same
range) while leaving every project big enough to hit.

**Hovering the strip slides the names out over the chat**, and that's the actual context-switching
move: at 56px an icon identifies a project only if you already know its icon, and a per-chip tooltip
makes you hunt one at a time. Opening once shows the whole list. It costs no layout — the strip keeps
its 56px footprint and the panel overlays — because a hover that shoves the chat sideways is worse
than no hover at all. Opening is delayed ~140ms and closing is not: a cursor travelling to the chat
shouldn't drag the list out behind it.

- **`bentoRail` is explicit persisted state, not a width derivation.** It has to survive a reload, and
  a percentage-of-viewport means a different thing on a 13" laptop than on a 32" display.
- **The drag never routes through React.** Every mousemove writes `--lw`/`--rw` straight to the shell's
  inline style and only `mouseup` commits to state. Going through `setPanelW` per pixel re-rendered the
  whole bento — every tile is a `motion.button` with `layout`, so each pixel re-ran a spring layout
  animation — and the divider visibly lagged the cursor. The variables it writes are the same ones the
  render sets, so the two can't disagree: the next render simply overwrites them.
- **The in-flight width lives in a ref, not the effect's closure** — see the post-mortem below.
- **The snap is immediate and hysteretic** — cross 260px and the bento becomes the rail on that frame;
  coming back out needs 170px. With one shared edge the divider chatters between states on a single
  pixel of mouse jitter.
- **The chat panel is `flex-1` when railed**, not a second percentage: the rail's width is in px, and
  `100% − a percentage` can't express "whatever the rail didn't take".
- **The rail's hover flyout is `fixed`, positioned off a measured rect.** The chip list scrolls on Y,
  and CSS forces `overflow-x` to clip whenever `overflow-y` does — anything drawn inside it is cut off
  at the rail's edge no matter what `overflow-x` says. It's a flyout rather than a `title` because the
  native tooltip's ~1s delay is far too slow for something you scan down a list of.
- **The bento header is `@container`-scoped too.** At a 60% chat panel that column is ~500px on a wide
  display: plenty of window, nowhere near enough column, and the old `md:` breakpoints happily
  overflowed it.

### Project icons — inferred, de-collided, assignable
The big 3D glyph on a tile is what you aim at without reading, in the grid and even more so in a 56px
rail. Three sources, in order: an explicit `icon` in `~/.minami-bento/icons.json` (served through
`/api/bento/attach`, maintained by the `bento-icons` skill) → a keyword match on the folder name → a
deterministic pick from a pool of distinct glyphs.

**Assignment happens for the whole visible set at once** (`assignIcons`), not per tile, because
distinctness is the entire point and a per-tile function can't see siblings: `ownego-growth` and
`ownegoCentral` both hit the `growth|central → rocket` rule and rendered identically — precisely when
you're trying to tell two projects apart. A collision falls through to the next matching rule, then to
the pool. Iteration is name-sorted so a glyph doesn't reshuffle when the grid's sort order changes.

> 🐛 **Every unrecognised project got the same icon.** The fallback was a flat `return "cube"`, so any
> name that didn't contain one of ~40 English keywords — which is most new topics, and every name in
> another language — got the identical grey box. A tile you can't tell from its neighbour is worse
> than an arbitrary one. Now the fallback hashes the name into a pool of ~27 distinct glyphs (`cube`
> deliberately excluded: it reads as "the icon this project didn't get"), the keyword table is roughly
> twice the size, and the store carries a hand-assignable override.
> *Reported by user: "the skill to semantically assign icon for topic is not working, new topic get
> default icon that is hard for context recognize and switching for human".*

#### How one icon moves — three motions, three elements
An icon has three things that want to move it: an idle **tumble** while its card is hovered, a
**lift** toward you on hover, and a **press** dip. All three want `transform`, which is one property,
and an `animation` owns it outright — so any two of them on the same element means one silently never
happens. `ProjectIcon` therefore renders three nested nodes: `.icon-3d` (static box, and the
drop-shadow, which §12 forbids putting on anything that moves) → `.icon-lift` (perspective + a
**transitioned** transform) → `.motion-icon` (the tumble, and nothing else). Rules live in
`app/globals.css` beside the keyframes.

The tumble is **paused, not removed**, at rest, and `.motion-icon`'s static transform is the same pose
as the `spin3d` 0%/100% keyframe. Both facts are load-bearing and both are about the same thing —
a CSS animation always restarts at 0%, so anything that adds or drops it mid-interaction snaps. This
costs nothing: a paused animation schedules no frames, which is the only measure §12 cares about.

> 🐛 **Two snaps per hover, on every icon on the board.** Hover *added* `animation: spin3d` to an
> untransformed icon, so it jumped 12° on enter and jumped back on leave; and the hover scale sat on
> the same wrapper as the drop-shadow, i.e. a CSS filter on a moving node — the one thing §12 says
> never to do. Worse, a **busy** tile got no hover response at all: `active` set the animation as an
> *inline* shorthand, which outranks every stylesheet rule, so both the hover rule and the
> reduced-motion kill-switch missed it. It is a class (`.motion-icon-live`) and a `--icon-spin`
> variable now. Hover and focus (`:focus-visible` — the tiles are real buttons and keyboard users had
> nothing) drive `animation-play-state` only.
> *Reported by user: "more robust icon movements and hover effect".*

> 🐛 **A resize that silently didn't take.** `useSetting`'s setter was recreated on every render, so
> the divider's drag effect — which lists it in its deps — tore down and re-subscribed whenever any
> state changed. Collapsing to the rail mid-gesture is exactly such a change, and the width in flight
> was a local inside that effect, so it reset to the pre-drag value and `mouseup` committed the wrong
> number. Fixed on both sides: the setter is `useCallback`-stable (an unstable setter is a trap for
> every effect that depends on one), and the pending width moved to a ref that survives re-subscription.
> Caught while verifying the drag, not reported.

> 🐛 **A setting that changed nothing until you reloaded.** *Reported by user: "I already found bug on
> the setting toggle omg".* Flipping **Agent view** in Settings wrote `bento:agentMode` and updated
> the Settings page — while the `Nav` two inches away kept showing the old menu. `useSetting` gave
> every call site a private `useState`, so a write only re-rendered the component that made it; other
> readers of the same key stayed stale until they happened to remount, which meant a reload or a route
> change. The toggle wasn't broken, it was invisible, and that's worse: you flip it twice, see nothing
> either time, and conclude the feature is dead.
>
> The fix is a module-level registry of every mounted reader per key, plus a `storage` listener for
> the cross-**tab** half of the same hole (two open dashboards drifted apart, and the stale one's next
> write reverted the other's change). Not a Context: these keys are read on different pages and inside
> panes that mount constantly, and a provider high enough to cover them all would re-render that whole
> tree on every keystroke — `draft:live:<id>` goes through this hook too.
>
> Worth noting what the class of bug is, because one toggle was only where it surfaced: **every key
> read in two places at once had it.** `showToolLogs` is written in Settings and read by every open
> pane; it had exactly the same lag and nobody had noticed, because you rarely watch both at once.
>
> Second-order fix in the same pass: the setter now resolves an updater function against a ref instead
> of React's functional form. It has to write storage and notify siblings, and doing either inside a
> state updater is illegal — updaters must be pure, StrictMode may invoke them twice, and calling
> setState on another component from inside one warns.

### The ask card — one question at a time, and one visible answer

`AskUserQuestion` arrives through the same `canUseTool` hook as a permission prompt (§3) and renders as
a wizard. Four rules, each of them a bug that was reported:

- **"Other" is an option, not a side channel.** It is the last row of the same list, it selects like any
  other row, and typing in it selects it. Previously the free text and the chips were independent state
  that both lit up — and single-select resolved by taking the chip and **silently discarding what you
  typed**. Now the sentinel `OTHER` lives in the same selection array as the real labels, so single- vs
  multi-select semantics are written once: picking a chip in single-select clears Other, and typing in
  Other clears the chip, in front of you.
- **The control's shape states the arity.** Radios for one, checkboxes for many, plus the words
  "Select all that apply" (with a live count) or "Select one" under the question. A multi-select
  question that looks identical to a single-select one is unanswerable by anyone who doesn't already
  know — the previous hint was 10px grey text in the footer corner.
- **One option per row.** The old `flex-wrap` chip row put option 3 above option 2 at some pane widths,
  so the same list reordered itself as the panel resized.
- **The Other row follows its text.** Text in the field means the row is part of the answer, and no
  click can withdraw it — only clearing the field can. Selection and free text are one state, so no
  gesture can leave a typed answer on screen that Send refuses to send.

The footer states the outcome rather than the rules: `sending: <the exact strings that will be sent>`.
Anything the card can't answer honestly (an empty Other row) is dropped rather than sent as `""`.

> 🐛 **You could type an answer into "Other" and then be unable to send it.** Rule 1 made typing select
> the Other row — correct — but the row's `onClick` was still the plain `toggle`, which read a click on
> an already-selected row as "deselect". So the sequence *type your answer → click the row* cleared the
> selection while leaving the text sitting in the field: `answerFor()` saw an empty `sel`, returned
> `null`, and **Send went disabled with the answer visibly on screen**. Nothing named the cause, and the
> obvious recovery — clicking the row again — just toggled it back off on the next click. `toggle` then
> called `otherRef.focus()` unconditionally, so the click that switched the row *off* still put the
> caret in it, which is why it read as a dead button rather than a deselect. Easy to hit by accident
> too: the input sits inside the row, so the padding around it is all click target.
>
> This one is not merely annoying. An unanswered `AskUserQuestion` holds the session at
> `phase=awaiting`, which is busy forever (§8) — so a stranded ask card blocks the pane *and* starves
> any deploy waiting for the box to go quiet, with `--wait` unable to win.
>
> Fix: while the Other field holds text, its row selects and never deselects (rule 4 above), and focus
> only follows a click that leaves the row on. Clearing the field remains the way to withdraw.
> *Reported by user: "cant send the other text detail answer option".*
>
> Found in the same audit: multi-select could send a duplicate when a typed value equalled an already
> ticked label (`["A","A"]`); `picks` is now de-duped.

### Motion, scroll and render cost

The interaction layer has three rules, and each replaced something ad hoc.

**One motion vocabulary.** `--dur-1..4` and two curves (`--ease-out`, `--ease-spring`) in
`globals.css`, with Tailwind's own `--default-transition-duration`/`-timing-function` retuned to match
so a bare `transition-colors` inherits the house curve. Before, the app used 150/200/300/500/700ms and
four different easings picked per call site — the thing that makes an interface feel assembled rather
than designed. The rule for choosing: anything the pointer is *on* (hover, press, focus) gets `--dur-1`
and must stay under ~120ms or it stops feeling attached to the input; state changing underneath you
gets `--dur-2`; only the layout-mode width transitions earn `--dur-4`.

- **Retune Tailwind's defaults, don't blanket-style `*`.** Setting `transition-duration` on `*` looks
  equivalent and is a trap: `transition-property`'s initial value is `all`, so every element would
  animate every property change, width and height included.
- **`transition-all` is banned** (zero left in the tree). It animates layout properties by accident and
  defeats the compositor; name the properties that actually change.
- **`prefers-reduced-motion` is honoured globally.** It was absent everywhere but one component. Large
  motion is genuinely painful with a vestibular disorder, and the OS toggle is the user saying so.
  Durations drop to 1ms rather than 0 — some engines skip `transitionend` at 0s, and anything awaiting
  it would hang.
- **`:focus-visible` exists at all now.** The UI is built from `<button>`s with custom borders, several
  setting `outline-none`, so keyboard focus was invisible. Defined with `:where()` so specificity stays
  at zero and a component can still opt out.

**Scroll is pinned, not forced.** `pinned` is state the reader owns: they leave it by scrolling away,
return by scrolling back or with the "jump to latest" button that only exists while unpinned. The
follow-the-stream effect no-ops unless pinned, and uses a straight `scrollTop` assignment — a smooth
scroll restarted 30×/second never arrives anywhere, so `behavior: "smooth"` belongs only to the
deliberate jump.

**Drags never route through React, and never through storage.** Both splitters now paint the frame
straight to the DOM and commit once on `mouseup`.

> 🐛 **The transcript yanked you back down mid-read.** The follow effect ran
> `scrollTop = scrollHeight` on every token with no pin check, so scrolling up to re-read something
> during a live turn pulled you to the bottom milliseconds later, every time, with no way to opt out
> short of stopping the turn.

> 🐛 **The browser splitter wrote to localStorage on every pixel of travel.** It called `setBrowserW`
> (a `useSetting`) from the mousemove handler, so each pixel re-rendered the whole pane *and* did a
> synchronous storage write inside a pointer handler — the textbook way to make a drag stutter.

**Turn rows are memoised.** A streaming reply mutates only the last turn, but the transcript was one
inline `.map`, so every token re-rendered every earlier turn's tool rows, badges and images.
`Markdown` was already memoised, which hid how much cost sat *around* it. `TurnRow` takes the volatile
props (`notices`/`activity`/`elapsed`/`busy`) only when it is the live row, so every other row is
prop-identical between renders. Measured on a 4-pane window with 310 rows mounted: 12 scroll-driven
state changes produced **20** row renders instead of ~900.

### Continuing a conversation — `claude --continue` parity

Opening a topic restores its recent sessions as panes, so those carry their own context. A **blank**
pane didn't: `＋ add chat`, a new topic, or a project with no remembered layout all spawned a session
that could see none of the project's history, so a follow-up asked there landed on a model with no idea
what it referred to.

A blank pane now offers to continue the topic's most recent conversation. Three things make it
predictable rather than magic:

- **It says so before you type.** Whether Claude can see the earlier conversation changes how you'd
  word the message, so the empty state names the chat it will pick up and how long ago it ran, with
  `Start fresh instead` next to it. The choice is per pane — `＋ add chat` still means "new" if you say so.
- **It draws a seam once it has.** A resumed pane adopts that session id, and `reconcile()` then pulls
  the whole transcript in from disk — so without a marker you'd be reading messages you never sent in
  this pane. `resumedFrom` is state, not derived: the moment the turn goes live `isNew` flips false and
  any derived value would vanish exactly when the marker is meant to appear.
- **It refuses to fork a transcript.** `resume` makes the CLI append to that conversation's JSONL, so
  two panes on one id means two subprocesses interleaving writes into one file. The pane skips ids
  already open elsewhere, and `sendMessage` **throws** if the id is live under another key — the client
  check races (a pane can go live between the render that offered the id and the send that uses it).
  It fails loudly on purpose: silently dropping `resume` would hand back a context-less session that
  looks like it worked, which is the exact failure this feature exists to remove.

**The candidate is scoped to `s.cwd === cwd`, and that is not redundant with "same topic."** A topic is
keyed on `basename(cwd)`, so `~/work/api` and `~/personal/api` are one topic whose `cwd` is whichever
session sorted first — without the test, a pane could resume a conversation recorded in one directory
and run it in another. Note also that the candidate pool is already filtered by the date-window chip and
`isTrivial`, so the target is the most recent chat *among those shown*, not necessarily the latest one
that exists. The UI names the chat and its age rather than claiming "your last chat", because that
phrasing would be false whenever the window excludes something newer.

**The SDK has a native `continue: boolean`** ("continue the most recent conversation in the current
directory", mutually exclusive with `resume`) that this deliberately does not use: it's opaque — you
can't name the target before sending — and it would happily grab a conversation that's live in another
pane, which is the corruption case below. `forkSession` defaults false, which is why `resume` appends to
the same file rather than branching; `forkSession: true` is the alternative design, trading split
history for immunity to two writers.

> 🐛 **The two-writers guard had a 1–2 second hole — in the exact window that mattered.** It consults
> the `live:<id>` alias, but that alias was only registered when the SDK's `init` message arrived, which
> is *after* the ~1-2s cold start the code elsewhere narrates as `spawning`. Two blank panes offering the
> same chat (neither has a session id yet, so neither appears in the other's `openSids`) that sent within
> that window both measured `cold`, both found no owner, and both spawned a subprocess appending to one
> JSONL — the precise corruption the guard exists to prevent. The id is now claimed at spawn time in
> `ensureSession`. `init` drops the claim if the SDK returns a *different* id: teardown only deletes the
> final `sessionId`, so an orphaned alias would outlive the session and make the guard reject that
> conversation as "already open" forever.

> 🐛 **A refused resume kept the id it had just been refused — and the first fix only half-worked.**
> `send()` adopts `opts.resume` before the POST (that's what lets the pane stream and reconcile as that
> conversation) but never gave it back on error, so a rejected continue left the message undelivered
> while the pane silently re-pointed itself at the very conversation it had been refused, with an
> optimistic user turn on screen implying otherwise.
>
> Undoing it in `use-agent` alone was **not enough**, which only running it revealed: `onLive` is
> one-way — it fires only on a *truthy* id — so the parent had already latched `pane.sid` and kept it.
> Measured on the preview: the pane retitled itself to the target chat while displaying
> `folder does not exist: /private/tmp/minami-permtest`. The release is now explicit, `onLive("")`,
> scoped by a ref to adoptions the pane made via continue so a pane opened directly on a session is
> never reset by it. `resumedFrom` is cleared with it — otherwise the seam would go on claiming context
> that was never loaded.
>
> The general lesson, and the reason this one is written up rather than quietly fixed: **optimistic
> state that flows outward needs a symmetric way back.** A rollback that only touches the local copy
> leaves every consumer that already latched it out of sync.

### The Autopilot tile — making the automation visible

Autopilot could merge, resolve and deploy on its own from the moment it shipped, and it recorded every
one of those in the event log. What it had no surface for was the *promise*: work landing without being
asked for is indistinguishable from work not happening, and the only places to check were a Settings
panel you had to go looking for and a bell that mixes it in with deploys, builds and everything else.
For the user this feature exists for — someone who cannot go and read `git log` — that gap is the whole
feature.

So it gets a tile, in the grid, sized and shaped like the things they already click. It answers four
questions in the order they get asked: **is it on** (state pill, plus the switch right there — making a
nervous user hunt through Settings for the one control they might need in a hurry is the wrong shape),
**is it doing something** (merging / resolving / deploying, live), **what did it just do** (the last
completed action in plain words, with a time), and **does it need me** (blocked work, amber, never
behind a click). The full log is one click away rather than on the tile, because a tile that tries to
be a feed stops being scannable.

Two translation rules make it readable, and both are load-bearing:
- **Titles are rewritten for outcome.** The log says "Autopilot merged idle-unpin"; the tile says
  "Combined idle-unpin into the main copy".
- **Only actions appear.** The runner emits standing-state notices ("waiting — uncommitted changes in
  the main checkout") once per process start; with a day's restarts, a log titled *what it has done*
  filled up with ten copies of what it did **not** do. Those still reach the bell, which is the right
  home for "FYI, blocked". Machine-generated bodies are dropped too — a successful deploy's body is a
  table of pids, BUILD_IDs and status codes, which is the exact register the tile exists to avoid. A
  *failed* deploy's body explains itself, so that one stays.

Server-side it needed two facts `status()` didn't expose: `deploying` (read from the deploy lock, so it
survives the restart the deploy itself causes — the exact window a user is most likely to be watching)
and `lastTickAt`.

> 🐛 **The log rendered near-black on near-black.** The modal portals to `document.body` so that
> `fixed inset-0` isn't trapped by the pane's `backdrop-blur` containing block (§5b) — but a portal
> escapes the app shell's inherited `text-neutral-100` as well, and body has no colour of its own. Every
> unstyled string in it was invisible. Any portalled surface has to state its own colour; the same trap
> as the lightbox, a different property.

### Composer
A `<textarea>` that grows to `MAX_H` (220px) and then scrolls, with a pixel-aligned mirror layer behind
it that tints markdown syntax without touching metrics (that constraint is why bold renders as dimmed
`**` rather than actual bold — a weight change would shift the text off the caret).

#### Attaching: four ways in, one thing they all do

Drag-and-drop, the 📎 menu's two native panels, the in-app browser and paste all end in the same
one-line operation — **put an absolute path in the textarea**. That is not tidiness, it is the
composer's contract (the textarea is the single source of truth for what Claude receives), and it is
what lets `lib/agent/images.ts` inline a dropped screenshot for free, with no code path of its own.

**The constraint that shapes all of it: a browser will not tell you a local file's path.**
`<input type="file">` and the File System Access API both hand back bytes and a bare `name`; the path
is withheld from web content and no flag returns it. So any browser-native picker forces a *copy* —
Claude gets pointed at a snapshot, and an edit lands in a temp file. Fine for "look at this
screenshot", quietly wrong for "change this module".

Hence two distinct routes, and the menu names the difference rather than hiding it:

- **`/api/fs/choose`** — the genuine AppKit open panel via `osascript`, returning a POSIX path. Bytes
  never move, so this is the one to use when Claude should *edit* the file. `activate` is required or
  the panel opens behind the browser and reads as a hang. Cancel arrives as exit 1 with `-128`, which
  is an ordinary outcome and must not surface as an error. One panel at a time (`inFlight`), because
  two modal dialogs stacked on the Mac steal the keyboard from each other. It opens on the machine
  running the server — which is why the in-app browser stays in the menu as the portable option.
- **`/api/fs/drop`** — the bytes fallback, when a drag discloses no path. Writes under
  `~/.minami/drops/` (not the session cwd — same reasoning as `/api/fs/paste`: the dashboard drops into
  every topic's folder and cannot edit their `.gitignore`s).

Drag-and-drop tries for a reference before settling for a copy: Chrome sometimes puts the real path in
the drag's `text/uri-list` as a `file://` URL, and when it does, that beats uploading. A dropped
**folder** has no bytes to fall back on at all, so if the path isn't disclosed it must say so — Chrome
reports a directory as a zero-byte `File`, and "attaching" that would write an empty file bearing the
folder's name, which is the worst available outcome because it looks like it worked.

> 🐛 **`my notes.ts` was saved as `my_20notes.ts`.** An HTTP header can't carry a space, so the client
> percent-encodes the filename into `x-filename` — and the server never decoded it. `%20` reached the
> sanitiser, whose allow-list excludes `%`, and got rewritten to `_20`. Decode before sanitising, and
> keep the raw value if it isn't valid encoding. Caught by dropping a file whose name had a space in
> it; a name without one would have passed forever.

Two DOM details that are load-bearing rather than defensive: `dragover` must `preventDefault()` on
*every* event or the drop is never allowed and the browser navigates the window to the dropped file
(throwing away the chat), and the drop overlay must be `pointer-events-none` — an overlay that accepts
the pointer becomes a child of the drop target and fires `dragleave` the instant it appears, cancelling
the drag under the cursor. `dragenter`/`dragleave` are counted, not toggled, since they fire for every
child crossed.

> 🐛 **An empty chat input rendered as a tall, oddly-wrapped box.** `scrollHeight` on an empty
> `<textarea>` reports the height of the wrapped **placeholder** — the browser lays that text out for
> real — so the auto-grow was sizing the composer to a string the user hadn't typed. "Message Claude in
> minami-dashboard…" wraps to three lines in a 150px pane (measured: `scrollHeight` 68px with an empty
> value), so in a 4-pane grid every idle composer sat there as a tall empty box whose shape changed
> with the project's name and the pane's width. The measurement is now skipped entirely while the value
> is empty, handing sizing back to `rows={1}`: 68px → 23px, exactly one line.
> *Reported by user: "weird box wrap in chat input".*

> 🐛 **Wrapped code chips were sliced in half.** An inline background that breaks across lines is
> `box-decoration-break: slice` by default: the first fragment's box runs to the edge of the line, both
> fragments get square inner corners, and horizontal padding lands only on the outermost ends. Both the
> composer's syntax tint and the message renderer's `<code>` hit it. `.chip-wrap` (globals.css) applies
> `clone` so each fragment draws a whole box. It's deliberately a metrics-free property — the
> composer's mirror must wrap identically to the textarea beneath it, so a tint may change how a glyph
> looks but never where it sits.

> 🐛 **Shift+Enter inserted a line you couldn't see.** The auto-grow measures by setting
> `height: auto`, which makes the box briefly tall enough to hold everything — and that zeroes
> `scrollTop`, which the browser does **not** restore when the height snaps back. So a newline at the
> bottom of a long draft was inserted correctly and then the view jumped elsewhere, and you had to
> scroll by hand to find your own caret. Fixed by saving `scrollTop` across the measurement and then
> scrolling the caret back into view. Finding the caret needs the mirror: nothing in the textarea API
> reports a caret's pixel position, and counting `\n`s is wrong the moment a line soft-wraps — which,
> in a 220px box, is most of them. The mirror holds the same characters at the same metrics, so a
> collapsed `Range` over its text nodes lands exactly where the caret is.
> *Reported by user: "the Shift enter combo didnt show me the new line, I have to scroll manually".*

> 🐛 **Clicking any chat pane drew a pink rectangle around its composer** — shipped by the very
> `:focus-visible` ring added to *improve* accessibility, in the same deploy as the three fixes above.
> Two things had to be true at once. First, **`:focus-visible` matches a text field on a plain mouse
> click**: the spec treats a typing target as always warranting an indicator, so the "keyboard only"
> intuition behind the rule is simply wrong for `input`/`textarea`/`select`. Second, the composer's own
> `outline-none` **could not override it** — `:where()` had been used to keep specificity at zero
> precisely so components could opt out, but the ring was unlayered while Tailwind's utilities live in
> `@layer utilities`, and **unlayered styles beat layered ones at any specificity**. Specificity was the
> wrong lever, so the documented escape hatch never worked. Fixed by dropping text fields from the
> selector: a caret already announces focus, and the composer's pill was *already* doing it properly
> with `focus-within:border-[var(--sakura)]/60`. Removed `border-radius: inherit` in the same pass — an
> outline follows the element's own corners anyway, while inheriting *replaces* them with the parent's
> for as long as focus lasts, squaring off a `rounded-full` button in a square container.
> *Reported by user: "when I click on chat panel - a pink rectangle show up".*

> ⚠ **Iterating from a dashboard pane needs `NODE_ENV=development` explicitly.** Every chat session is
> a child of the production `next-server`, so it inherits `NODE_ENV=production` — and `next dev` under
> that mis-compiles `globals.css` ("Module parse failed: Unexpected character '@'") and 500s every
> route. Run `NODE_ENV=development npm run dev:iterate`.

### Reclaiming the panel — four cuts, one theme

Tab view made three pieces of older chrome redundant at once, and each was still being paid for. The
theme: **a control that restates something already on screen is not chrome, it's noise** — and the
oldest of them was actively fighting the user.

**1. The auto-rail heuristic outlived its premise.** Crossing 3 panes railed the bento to buy the panel
width. That was written when 3 panes meant 3 transcripts side by side. It keys off `panes.length` —
chats **open** — but tab view shows exactly one however many are open, so opening a topic with four
remembered chats railed the board instantly, every time, for panes that were never on screen. You
clicked a tile and the thing you clicked disappeared. Now gated on `paneView === "grid"`, where the
premise still holds.
*Reported by user: "when I click on it ... it automatically open the bento strip view - which is not okay".*

**2. The hover-reveal header displaced the row you were aiming at.** The identity header collapsed to
0px and expanded on hover — *above* the tab row, so every reveal pushed the tabs down by its full
height. Hovering a tab therefore moved that tab out from under the cursor, at exactly the moment the
hover triggered the reveal. The fix is ordering, not timing: tabs are the part you operate, so they
take the fixed position and the reveal opens **below** them, `absolute` so it displaces nothing and
floats over the first rows of transcript instead. Pinned stays static — pinning is a decision to keep
the header, and it must not then sit on the text you pinned it to read alongside.
Measured before/after: tab row `top: 0` and first tab `top: 6` both with and without hover.
*Reported by user: "the hovering title appearance make it akward to click on tab because it shift the tab navigation down".*

**3. The per-pane header restated the lit tab.** Icon + title + goal line, ~30px under a tab carrying
the same title. Collapsed to the bare `⌄` switcher when `focused` (tabs view, single visible pane).
Grid view keeps the full title — there is no lit tab there, and an unlabelled cell in a 2×2 can't be
identified.

**4. Measure, not width.** A maximised chat on a wide display ran prose the full column: past ~75
characters the eye loses its place on the return sweep. `[&>*]:max-w-3xl` caps the **children**, so the
scroll area and scrollbar stay full-bleed at the pane edge and only the content centres. Deliberately
unconditional — it can only bind where there is excess width, so grid view and side-panel-open columns
are already narrower and it does nothing.
*Reported by user: "for chat log in full focus view, it should be like centered ... rather run full screen - having awful readability".*

---

### One control language — the segmented control, and committing to a single theme

Nine places had independently grown the same control: a bordered box holding two to five small
buttons, one of them tinted as "selected". Bento's time window and sort, the composer's Plan/Code and
approval level, both of those again in `/settings`, `Nav`, the heatmap range, the slot tabs. No two
agreed — `px-2` vs `px-1.5`, `text-[10px]` vs `[10.5px]` vs `[11px]`, `rounded-md`-inside-`rounded-lg`
vs loose `rounded-full` pills, and three different treatments for the active segment.

None of them was wrong on its own, which is exactly why they drifted: nothing ever looked broken
enough to fix. But the composer's control row put four of the variants side by side, and a row of
four near-misses is what makes an interface read as **assembled rather than designed**.

`components/ui/Segmented.tsx` is now the one implementation. Two details in it are load-bearing:

- **`shrink-0 whitespace-nowrap`.** In `/settings` these controls sit in a `justify-between` row
  opposite three lines of description, and flex was shrinking the control to pay for the text —
  `auto-edits` wrapped mid-word inside its own segment.
- **`tone`.** Exactly one selected state must not look like an ordinary selection: `bypassPermissions`
  auto-runs every tool. It gets `good` (green); everything else is the accent. The prop exists for
  that one case, not for decoration.

The lone `⏸ pause` button beside them is padded as `border p-0.5` around an inner `px-2 py-0.5` rather
than padded directly, purely so its box metrics equal a one-option `Segmented`. Styled the obvious
way it sat 4px shorter than its neighbours — a difference you see without being able to name.

> 🐛 **The same flex-shrink bug, in the switch nobody re-checked.** `shrink-0` was added to
> `Segmented` when `auto-edits` wrapped mid-word, and the fix stopped there. `Toggle` in
> `app/settings/page.tsx` sits in the *same* `justify-between` row opposite the *same* description
> paragraph and never got it, so it kept `flex-shrink: 1`. Measured on the live build: **Agent view's
> track rendered 25.4px against its declared `w-11` (44px)**, while `Show tool logs` — same component,
> one-line description, row doesn't overflow — rendered a correct 44px. The knob is
> `absolute … h-5 w-5`, so it does *not* shrink with the track; a 20px knob in a 25px track leaves
> ~5px of visible pill and the control reads as a plain circle. It still toggled, which is why this
> survived: every functional check passed, and `agentMode` had already been blamed once before (see
> the invisible-write post-mortem above), so "the agent toggle is broken" looked like a repeat of a
> bug that was actually fixed.
>
> *Reported by user: "the agent toggle in the setting still error … the toggle is broken - not a
> normal toggle".*
>
> The general shape: **when a control's width carries its meaning, it must never be the flex item
> that gives.** A switch has nowhere for the knob to travel once the track collapses. Audited the rest
> — `AutopilotPanel`, `AutopilotTile` and `Segmented` all already carry `shrink-0`; settings' `Toggle`
> was the only one missing it.

**The theme was only ever half-committed.** The bento board and `/settings` force dark with
`.bg-bento`; `/dashboard`'s cards were the only surface carrying `dark:` variants, and the root layout
left the choice to the OS. On a machine preferring light, `/dashboard` therefore rendered light while
everything one click away rendered dark — and `Nav`, whose colours are hardcoded `border-white/10`,
was nearly invisible on it. `<html className="dark">` settles it, which is what allowed 38 `light
dark:X` pairs across ten files to collapse to `X`.

> 🐛 **The tile stats ran underneath the FLOW switch.** The switch is `absolute bottom-3 right-3` and
> has to be: it's a `<button>`, and the stats row lives inside the tile's own `<button>`, which can't
> nest. So the row and the switch were laid out in ignorance of each other, and `1.5M tok` / `8 chats`
> were struck through by the pill on 6 of 8 tiles at 1512px.
>
> `pr-14` reserves the footprint, but that alone fixed only the wide case: the stat spans were
> `shrink-0`, so at rail width they overflowed the padding and slid under the pill anyway. The spans
> now also drop by **container** width (`@min-[200px]`, `@min-[280px]`), with `@container` on the tile
> wrapper — the same tile renders at ~175px beside an open chat and ~725px as the featured tile, and a
> viewport breakpoint cannot tell those apart because it is the same viewport. Request count never
> drops; it's the number the tile is sorted and sized by.

> 🐛 **One reply rendered five `CLAUDE` headers.** An assistant turn commonly renders as several rows
> (paragraph, tool run, paragraph), and each row labelled itself. Stacked, the label stopped separating
> speakers and became texture. `TurnRow` now takes `sameSpeaker` — derived at the call site as a plain
> boolean so the `memo` comparison stays shallow — and suppresses the label on a continuation.
>
> The gap needed to follow. `space-y-*` on the scroll container writes `margin-top` via `& > * + *`,
> whose specificity beats any utility class the child could carry, so the pull-up is an **inline
> style**: `calc(var(--turn-gap) * -0.55)`. `--turn-gap` is set alongside each density branch's
> `space-y`, because the child can't know which of the four branches its parent took.

> 🐛 **The live activity line rendered twice, ~40px apart, saying the same words.** The streaming row
> carries a full `ActivityLine`; the composer control row carried a `compact` one. Both showed
> "taking a screenshot · 0s". The control row is the **fallback** — it earns its place when the
> transcript's copy isn't there (scrolled out, or a reattach before the first snapshot lands), which
> is the same condition the safety net under `visible.map` already tests. When the transcript has it,
> that end of the row now says the one thing the transcript doesn't: live, and in which mode.

**`/dashboard`'s four empty panels became one.** Task log, Trace-back, Analytics and People are all
fed by `MINAMI_PANELS_FILE`, so on an unconfigured box they were four full-height cards carrying four
copies of one sentence — about a third of the board spent saying the same thing. Each card now renders
only when it has data; whatever is left over collapses into a single `Personal panels` card that names
them and gives the instruction once. Also on that page: the model grid was `grid-cols-4` against five
`MODELS`, orphaning Fable 5 alone on a second row a quarter-card wide (it read as a rendering fault,
not a fifth model) — the column count is now tied to `MODELS.length`, so adding a tier can't
reintroduce it.
