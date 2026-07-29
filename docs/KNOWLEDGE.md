# Minami Bento — Knowledge Record

The authoritative reasoning record for this codebase. `README.md` says how to run it; this says
**why it is shaped the way it is**, what breaks if you change it, and what already broke once.

Kept in sync by the `minami-kb` skill: *any turn that changes a subsystem updates its section in the
same turn.* A doc that lags is worse than no doc, because the next session trusts it.

- **Visual explainer:** [`public/kb/architecture.html`](../public/kb/architecture.html) — the same
  material with diagrams. Read that first if you're new.
- **Module map:** `/architecture` in the running app — real import/fetch edges.
- **Front door:** [`public/kb/index.html`](../public/kb/index.html).

---

## Data flow

Three pipelines run at once. Most confusion about this codebase comes from reading one and assuming
it explains another.

```
LIVE      browser pane → /api/agent/send → manager.ts → Agent SDK → claude CLI
                       ← /api/agent/stream (SSE) ←

READ      claude CLI writes ~/.claude/projects/*.jsonl
          → claude-sessions.ts (incremental parse + 3 caches) → /api/bento/* → grid tiles

METRICS   Stop hook on EVERY machine → metrics-server.js (Hetzner, loopback)
          → events.jsonl → Tailscale Funnel → /dashboard cards
```

The live and read pipelines meet only on disk. They never call each other.

---

## Subsystem status

| Subsystem | File | State | Notes |
|---|---|---|---|
| Live sessions | `lib/agent/manager.ts` | **shipped** | Opus 5, effort unset, 60% autocompact |
| Activity labels | `lib/agent/labels.ts` | **shipped** | server-derived, survives refresh |
| Transcript parser | `lib/claude-sessions.ts` | **shipped** | incremental meta *and* turns; windowed history paging — see §1 |
| Transcript CLI | `bin/transcript.mjs` | **shipped** | full history, no server, no caps — see §1 |
| Client SSE | `lib/use-agent.ts` | **shipped** | reconnect-aware |
| Metrics collector | `server/metrics-server.js` | **shipped** | systemd on Hetzner |
| Account bridge | `app/api/accounts` | **shipped** | reads ground-truth identity |
| Browser panel | `lib/browser-view.ts` + `components/BrowserPanel.tsx` | **shipped** | derived from tool results; observer-only — see §5b |
| Topic creation | `components/FolderPicker.tsx` + `app/api/fs/*` | **shipped** | can create folders; cwd validated — see §5d |
| Message rendering | `components/Markdown.tsx` + `components/ThoughtBlock.tsx` | **shipped** | one parser, two tones — see §5c |
| Shell (bento · rail · composer) | `app/page.tsx` + `components/BentoRail.tsx` | **shipped** | grid collapses to a rail — see §5e |
| Module map | `app/architecture` | **shipped** | graph data hand-maintained — see §7 |
| KB standalone server | `public/kb/serve.mjs` | **shipped** | `npm run kb` → :4400, zero deps |
| Runbook | `public/kb/operations.html` | **shipped** | deploy · identity · symptom table |
| Deploy wrapper | `bin/deploy.sh` + `Redeploy Minami.command` | **shipped** | detaches from its requester; mutually exclusive — see §8 |
| Task isolation | `bin/task.mjs` | **shipped** | one task = one worktree = one branch = one agent — see §9 |
| Out-of-pane alerts | `bin/minami-event.mjs` + `lib/events.ts` | **shipped** | disk-backed, survives the deploy that produces them — see §10 |
| Images in a message | `lib/agent/images.ts` + `app/api/fs/paste` | **shipped** | paste a screenshot; path is the payload, so it survives a reload — see §11 |
| Rendering cost | `app/globals.css`, `ProjectIcon.tsx` | **shipped** | idle GPU 31% → 14%; never animate inside a backdrop-blur — see §12 |

---

## 1. Transcript parser — `lib/claude-sessions.ts`

**Grain:** one `SessionMeta` per `~/.claude/projects/<enc-cwd>/<id>.jsonl` file.
**Consumers:** `/api/bento/sessions` (grid), `/api/bento/session/[id]` (one transcript).

### Mechanics
Two passes. First a **stat-only** sweep over every project dir, sorted by mtime and capped to
`CANDIDATE_WINDOW = 150`. Only then does `summarize()` touch file contents. Filtering happens
*before* the expensive step, not inside it.

`summarize()` branches three ways on the cache key `(mtime, size, sha1-of-first-4KB)`:

| Condition | Action |
|---|---|
| all three match | return cached meta, **zero bytes read** |
| mtime/size changed, head hash same | read **only appended bytes**, fold into `ParseAccum` |
| head hash differs, or size shrank | discard accumulator, **full re-parse** |

> 🐛 **The bug this cost us.** The original version re-read and re-parsed the *entire* file whenever
> mtime changed. An active session appends on nearly every turn, so its mtime changes on nearly every
> 5-second poll — meaning a 29 MB transcript was fully re-parsed every few seconds on Node's single
> event loop. Every request, every open pane, and every SSE broadcast froze for the duration, for as
> long as that session stayed live.

> 🐛 **The second bug, hiding inside the fix.** With a correct incremental parser and a 500-entry
> cache, 375 transcripts still froze the app — summarizing *every* file each sweep pushed past the
> cache bound mid-sweep, so the sweep evicted and force-reparsed large files **it had just cached**.
> Cache thrash, indistinguishable from the original symptom. `CANDIDATE_WINDOW` is what actually
> fixed it.

### Turns: windows, not a tail

`getSession()` returns a **page**, not a truncated tail: `{ meta, turns, start, hasMore }`, where
`start` is the byte offset the window begins at and `hasMore` is simply `start > 0`. Every `Turn`
carries `off`, the byte offset of the JSONL line that produced it — that is what makes a window
addressable at all.

| Request | Reads | Cached |
|---|---|---|
| tail (no param) | back from EOF until ≥60 turns or ≥512 KB | by `(mtime, size)`, folded incrementally |
| `?before=<off>` | back from that offset, same rule | **forever, by byte range — never invalidated** |

The asymmetry is the whole design. A transcript is append-only, so **any window below the live tail
is immutable**: a history page is read once, ever, and the only thing that can invalidate it is a
truncate-and-rewrite, caught by the same head fingerprint `summarize()` uses. The tail is the only
volatile part, and it is folded incrementally exactly like meta — so a live pane's 2.5 s poll reads
the bytes appended since the last poll, not the window.

The in-memory window grows to `LIVE_WINDOW_TURNS = 400` then trims from the front, and `trimWindow()`
resets `start` to `turns[0].off` so a trimmed window is still a valid page and `hasMore` stays true.

> 🐛 **90% of long conversations were unreachable, with no indication.** *Reported by user: "the
> older history log transcript is not accessible for some chat or session — where it should show
> load old message".* Turns were read from a fixed 1.5 MB tail and then `slice(-120)`, so on a
> 64 MB / 1813-turn transcript **only 91 turns — 5% — could ever be displayed**; on a 12.9 MB / 863-turn
> one, 120 turns (14%). Nothing said so. The "Show N earlier messages" button computed `hiddenCount`
> from what the server had already sent, so it paged through the client-side render limit and then
> *vanished* — which reads as "you have reached the beginning of the conversation". There was no
> mechanism to ask for more: the route took an id and nothing else. The giveaway was that a pane
> showed a **title from the head of the file** (meta comes from `listSessions`' full read) above
> **turns from the tail** — 39 of 421 transcripts on disk exceed the old cap.

### Gotchas
- **The head fingerprint is not optional.** A truncate-and-rewrite to a coincidentally equal-or-larger
  size is indistinguishable from an append under `(mtime, size)` alone — the parser would fold
  unrelated bytes into the accumulator and produce a permanently wrong total, silently.
- **Byte reads can split a UTF-8 character.** `Buffer#toString` replaces the fragment with `U+FFFD`,
  corrupting a line that was valid on disk. `splitTrailingIncompleteUtf8()` holds the tail fragment
  back for the next read.
- `readTurnsBack()` widens up to `WINDOW_HARD_CAP` if a single JSONL line exceeds the window — a big
  embedded screenshot will do this.
- **Find the page boundary in the `Buffer`, not the decoded string.** Slicing mid-file almost always
  lands inside a UTF-8 sequence, so the decoded string contains `U+FFFD` and any byte offset computed
  from a *string* index is silently wrong — which is exactly the off-by-N that makes two pages
  overlap or skip the turns between them.
- **The incremental fold's chunk offset is not `cached.size`.** The held partial line's bytes were
  already counted in it, so the chunk starts that far back. Get this wrong and every turn in the fold
  is labelled with a too-large `off`, and paging from it skips everything in between.
- **The tool index must survive a fold.** `tool_use` and its `tool_result` sit on different lines and
  can land in different chunks, so it is rebuilt from the last 20 turns rather than started empty —
  otherwise a tool call parsed in the previous chunk never gets its output attached.

### Reading a transcript without the app — `bin/transcript.mjs`

The dashboard's windowing is right for a polled UI and wrong for "show me the whole conversation".
The CLI is the other half: one streaming forward pass, bounded memory, **no caps, no cache, no
server** — so it works while `:3000` is down, which is when you tend to need it.

```bash
node bin/transcript.mjs list minami-dashboard          # sessions, newest first
node bin/transcript.mjs show b33e1c2c                  # whole conversation (id prefix is enough)
node bin/transcript.mjs show b33e1c2c --tail 20 --tools
node bin/transcript.mjs show b33e1c2c --format md --out /tmp/chat.md
node bin/transcript.mjs show b33e1c2c --format json | jq -r 'select(.role=="user") | .text'
```

`--format json` emits JSONL, one turn per line — the surface for token-slayer and `jq`. Measured:
**1813 turns out of a 64 MB transcript in 0.25 s.**

> **Do not "unify" this with `lib/claude-sessions.ts`.** The similarity is superficial and the
> duplication is deliberate: collapsing them means either the dashboard full-reads on every poll, or
> the CLI inherits the window and silently stops being able to show you everything. Different jobs.

---

## 2. The caches

Three caches, three bounds, each chosen for a different reason.

| Cache | Bound | Key | Why that bound |
|---|---|---|---|
| meta (`~/.minami-bento/meta-cache.json`) | 500 | mtime · size · head sha | disk-mirrored; cold launch went **9.3 s → 8 ms** |
| turns — live tail | 60 files · 400 turns | file · mtime · size · head sha | only a few panes are ever open |
| turns — history pages | 24 pages | file · byte offset | **immutable; no mtime, no invalidation** |
| turns on disk (`turns-cache.json`) | 64 KB **per entry** | — | a turn count is the wrong budget — see below |
| id → path index | 2000 | session id | cheap per entry, can afford to be large |
| *candidate window* | *150* | *mtime rank* | *not a cache — the pre-filter from §1* |

> 🐛 **The warm-start cache was costing more than it saved.** `saveTurnsDiskCache()` ran on every
> reparse — and a live session's mtime changes on essentially every 2.5 s poll — so it did a
> `JSON.stringify` of all 60 cached sessions plus a **synchronous 7.9 MB `writeFileSync`**, on Node's
> single event loop, several times a second, exactly when the dashboard was busiest. Its own comment
> claimed this was cheap because it "only fires on an actual reparse". Now throttled to 15 s and
> budgeted **by serialised bytes, not turn count**: tool inputs/outputs dominate an entry's size, so
> 60 turns of a screenshot-heavy session serialised to ~450 KB while 60 turns of plain chat is a few.
> **7.9 MB → 251 KB**, worst case ~3.1 MB at a full 60 entries.

> 🐛 **Curated labels vanished.** A torn write to the enrichment cache left JSON that failed to
> parse, which returned `{}` — and the next `enrich()` wrote that empty object back, permanently
> erasing every hand-curated goal/task label. Both disk caches now write to a temp file and
> `rename` into place, and `enrich()` re-reads immediately before merging.

### Gotchas
- Caches live on `globalThis` so a Next dev hot-reload doesn't orphan them.
- Unbounded `Map`s keyed by session id are a real leak here, not a theoretical one — one entry per
  session ever seen, across weeks.

---

## 3. Live sessions — `lib/agent/manager.ts`

**Model defaults:** `claude-opus-5`, effort deliberately **unset** (the SDK/model default), autocompact
at 60%. All three overridable via `MINAMI_DASHBOARD_MODEL` / `_EFFORT` / `_AUTOCOMPACT_PCT`.
Deliberately *not* pinned to `--effort high` the way Minami's cloud brain is — that's a
weekly-subscription-limit lever the dashboard doesn't need.

### Mechanics
One long-lived SDK `query()` per pane in streaming-input mode. The registry (`store`, on
`globalThis`) holds each session under **two keys**: its pane key, and `live:<sessionId>` once the
SDK reports one. The second key is what lets any pane — or the same pane after a refresh — reattach
to a running session instead of starting a cold duplicate.

`canUseTool` is the single hook for both tool-permission prompts and Claude's `AskUserQuestion`. It
parks a promise in `s.pending` and blocks.

**Permission modes are enforced here, in `canUseTool` — not by the SDK.** Each session carries its own
`s.mode`, and the hook decides before it ever prompts: `bypassPermissions` allows everything,
`acceptEdits` allows the edit tools (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`), everything else asks.
`AskUserQuestion` is exempt from all of it — it isn't a permission, it's Claude asking the human a
question, and auto-answering it would throw the question away. The mode is still handed to the SDK at
spawn time *and* on change, so the CLI's own state agrees; it just isn't trusted to be the enforcer.

**`bypassPermissions` is this install's default** (`DEFAULT_PERMISSION_MODE`, overridable with
`MINAMI_DASHBOARD_PERMISSION_MODE`) — Thomas's call for a local, single-user box. Note the asymmetry
that keeps it safe: a *missing* mode gets that default, but an *unrecognised* mode string still clamps
to the most restrictive `default`. Garbage input can never widen permissions. This is also why §"Security
posture" matters more than it looks: with bypass as the default, anything that can reach the local API
can run tools without a prompt.

Two separators in the outgoing stream are the server's invention, not the model's: `\n\n` when a new
text block opens mid-turn, and `\n---\n` when a second thinking block does. Content-block boundaries
carry no delimiter of their own, and without them the pane renders two distinct passes as one
paragraph — see §5c.

### Gotchas
- **Removing a session must remove both aliases**, identity-checked (`store.get(s.key) === s`),
  or cleanup for a dead session can delete a newer one that reclaimed the pane key.
- **A parked permission promise that nobody resolves pins the session `busy` forever** — no `result`
  ever arrives to trigger cleanup, so the session and its subprocess leak permanently. Three paths
  auto-deny: the idle reaper, the consumer loop's `finally`, and `closeSession()`.

> 🐛 **The permission pills were decorative on a warm session.** `setMode()` called the SDK's
> `q.setPermissionMode()` and the route answered `{ok:true}` unconditionally — including when the key
> matched no live session at all. Measured against the running server: flip a warm session to
> `bypassPermissions`, get `ok:true`, and the very next Bash write **still raised a prompt**; the file
> it wanted to create never appeared. A session *born* in bypass, by contrast, never called `canUseTool`
> once — so the mode works at spawn time and the mid-session control request is accepted and dropped.
> Two things were wrong and both are fixed: the server now enforces the mode itself in `canUseTool`
> (the gate it already owns), and `setMode` returns whether a live session actually took the change so
> the pill reverts instead of lighting up over a no-op. `sendMessage` also re-applies the mode each
> turn, so a pane that reloaded can't leave a session running under a level nobody is looking at.
> *Reported by user: "check if the permission pill click are actually effective".*

> 🐛 **Stop denied the wrong turn.** `stop()` used to deny whatever was in `pending` *after* awaiting
> `interrupt()`. A fast follow-up message could raise its own prompt during that await, and get
> denied with a stale "Stopped by user". Now it snapshots pending entries before awaiting.

> 🐛 **One stale promise killed the whole server.** `setPermissionMode()` is intentionally not
> awaited from route handlers. With no handler, Node's default on an unhandled rejection is to exit
> the process — taking every open pane with it. `instrumentation.ts` installs process-level handlers
> as the backstop; `metrics-server.js` got the same after `JSON.parse("null")` (which does not throw)
> made the next line throw and killed the collector.

---

### Restart safety — the deploy kills every conversation

Every live session's SDK subprocess is a **child of the Next server process**. `bin/serve.sh` kills
whatever holds `:3000`, so a deploy doesn't just swap the UI — it takes down every in-flight turn on
the box and its MCP servers. Worse, the trigger is usually a *different* pane finishing an edit, so
the interruption lands on whoever happens to be typing. That is the real source of "my request got
interrupted and I never touched anything."

`drainForRestart(timeoutMs = 60_000)` broadcasts a `notice{kind:"restarting"}` to every pane — the
one notice a user gets *before* the disruption — then polls every 250 ms until nothing is busy. It
deliberately closes nothing; the caller is about to kill the process anyway, and a turn that lands
inside the window writes its result to the JSONL, which is what a pane reconciles against on the new
build. `bin/serve.sh` also refuses to start when a turn is in flight unless given `--force`.

> ⚠️ **This is a blast-radius reducer, not a fix.** The durable answer is hosting sessions outside
> the process that gets redeployed. The code says so itself.

> 🐛 **The drain endpoint can't gate on "is this loopback".** A Next route handler has no access to
> the peer socket address, and `x-forwarded-for` proves nothing: Next backfills it from
> `socket.remoteAddress` (so its presence isn't evidence of a proxy hop — an early version treated it
> as such and 403'd its own caller), and it only fills the header when *absent*, so any LAN client can
> send `x-forwarded-for: 127.0.0.1` via `curl -H` and have it preserved verbatim. It now gates on a
> shared secret in a `0600` file, compared with `timingSafeEqual` after a length precheck — that
> function throws on length mismatch, which would leak length through the error path. No token file
> means **deny**.

---

## 4. Activity labels — `lib/agent/labels.ts`

Computed **server-side on purpose**: it survives a browser refresh by riding the reconnect snapshot,
and it makes it impossible for the inline transcript indicator and the composer status line to
disagree, because there is only one source.

Phases: `idle · spawning · thinking · responding · tool · awaiting · retrying · compacting`.

### Gotchas
- `settle()` must recompute the phase from what's *still* in flight after a tool result lands.
  Without it a finished tool's label stays on screen — the stale-label bug.
- Tool labels refine from **streaming partial JSON**, so a fast tool shows its real target
  ("reading package.json") for essentially its whole life rather than a generic placeholder.

---

## 5. Client SSE — `lib/use-agent.ts`

`EventSource` reconnects at the transport level **silently**. The socket returns, but everything
streamed during the gap is missing and nothing above the transport knows. Any `onopen` past the
first is therefore treated as a reconnect: tear down and reopen as an explicit attach.

### Gotchas
- **After a resync you hold two versions of the turn.** Prefer local blindly → lose what arrived
  during the outage. Prefer server blindly → roll back text the user already watched appear. The
  tiebreak is timing (`lastDeltaAtRef` vs the resync start), not a guess about which is fresher.
- `sentOnce` only flips true on a `snapshot` event — *proof* a live session exists — never
  optimistically on send. Until then every send carries `resume: <sessionId>`, so a lost connection
  can't silently start a fresh, context-less session.

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

Two things stay on the bar unconditionally: the **console-error badge** (a problem you must open a menu
to discover is a problem you don't discover) and **open-in-your-own-browser**, revealed on hover of the
address it would open — opening a localhost dev server for real is the most-reached-for thing here.

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

## 5c. Message rendering — `components/Markdown.tsx`, `components/ThoughtBlock.tsx`

One dependency-light GFM-ish parser renders **both** the answer and the reasoning. `Markdown` takes a
`tone` (`"chat" | "thought"`) that selects a palette — strong/em/code/heading/rule/marker colours,
line-height, paragraph gap — and nothing else. That is the whole point: a separate thought renderer
would drift the moment a block type is added to one and not the other, and reasoning that loses its
lists and bold lead-ins is exactly the reasoning that becomes unreadable.

`caret` parks a pulsing cursor at the **end of the last paragraph** while text is still streaming.
It's computed from the last non-empty line index up front, not appended as a trailing node, because a
cursor on its own line below the text reads as a stray artifact rather than "still writing".

### Reasoning passes and the `---` seam

A turn's reasoning arrives as several *passes*: one before the first tool call, one after each
result. Streamed end-to-end they glue into a single contradictory paragraph — "I'll check X" running
straight into "so X was wrong" — with no way to see where a tool result changed Claude's mind.

`manager.ts` therefore marks the boundary the same way it already marks a new text block: on a second
`content_block_start` of type `thinking`, it broadcasts `\n---\n` into the thinking stream.
`ThoughtBlock` splits on that seam and draws a numbered hairline between passes.

### Gotchas
- The seam is gated on **`sawThinking`**, which the *deltas* set — not the block start. Some setups
  open thinking blocks with an empty body (see the `thinking: {display: "summarized"}` option in §3),
  and an empty pass must not earn a divider. A trailing seam with nothing after it is dropped
  client-side by the `.filter(Boolean)` on trimmed passes.
- `sawThinking` resets per **turn** (alongside `sawText` in `sendMessage`), not per message —
  `partialThinking` resets per message. Different lifetimes on purpose: the client accumulates
  thinking across every assistant message in the turn, while the snapshot only replays the current
  message.
- A literal `---` inside the reasoning itself splits a pass. Harmless — it would have rendered as a
  rule anyway — and not worth a more exotic sentinel that leaks into view if the parse ever changes.
- Collapsed, the disclosure shows pass and word counts. Without them a 40-word aside and a 900-word
  deliberation present identically, and the control gives you no reason to open either.

> 🐛 **Reasoning was one unreadable wall.** The thought block rendered the raw string in a single
> `div` with `italic`: HTML collapsed every `\n\n`, so paragraph structure vanished entirely, lists
> came out as run-on sentences, and the whole thing was set in italic — emphasis on everything is
> emphasis on nothing — at 13px muted grey. Passes from different points in the turn were glued with
> no separator at all. *Reported by user: "thought process print also need proper typography and
> divider of some sort to have better readability".*

---

## 5d. Creating a topic — `components/FolderPicker.tsx`, `app/api/fs/*`, `isTrivial`

A "topic" is not a stored object. It's an emergent grouping: `listSessions()` derives
`project` from the **last path segment of a session's cwd**, and the grid groups by that. So the only
way to create a topic is to run a session in a folder — which means the folder has to exist, the send
has to succeed, and the resulting session has to survive the grid's filters. All three of those were
broken at once, and together they made "start a new topic" look like a feature that simply didn't work.

### Mechanics
- `FolderPicker` browses via `GET /api/fs/list` and creates via `POST /api/fs/mkdir` (empty directories
  only). `startTopic()` then holds the topic as **client state** (`newTopic`) with one blank pane; the
  topic only becomes real once a session lands on disk under that cwd.
- `POST /api/agent/send` now stats `cwd` and rejects a missing path or a file with a 400.

### Gotchas
- **`data.path` from `/api/fs/list` never meant "this folder exists".** The route reports a missing
  directory by echoing the requested path back *with* an `error` field, so any check on `path` alone
  passes for a folder that isn't there.
- **A topic has no tile until its session survives `isTrivial`.** `messages` counts user AND assistant
  records, so a first exchange is exactly 2 — see the post-mortem below.
- `openPanesMap` remembers panes by **project name**, and a pane only learns its session id from the SSE
  `init` event, not from the send response (`sendMessage()` returns `sessionId: null` for a cold
  session).

> 🐛 **"Bento can't create a topic" — three independent bugs stacked.** Reported by user: *"I am having
> a chat in the second brain bento that should populate the topic ownegogrowth with it dedicated folder
> on my local machine — check why minami bento cant create such topic."*
>
> 1. **The picker offered folders that don't exist.** `Start chat here` was enabled whenever
>    `data?.path` was set, which is *always* — including for an ENOENT path. The only hint was a generic
>    "Can't read this folder.", which reads like a permissions problem.
> 2. **`cwd` was never validated.** `api/agent/send` checked truthiness only, then handed the path to
>    `query({ cwd })`. The SDK subprocess fails to spawn on a non-existent directory, and because that
>    happens *before* the first turn completes it never emits a `result` — so the pane produced no
>    reply, no transcript, no project dir, and no tile, explained only by an error clipped to 44 chars
>    in the composer. `manager.ts` already named "bad cwd" as a known failure mode.
> 3. **`isTrivial` hid the result even on success.** `messages < 3` returned true unconditionally, and a
>    real first exchange is 2 messages — so the tile appeared only on the *third* message. Proven
>    against live data: the `tmp` project was returned by the API with two 2-message sessions and had no
>    tile. Thin sessions are now only trivial once cold (`FRESH_MS`, 24h) and not live.
>
> Each one alone is survivable; stacked, there was no path to a working new topic at all. The lesson is
> the same one behind most entries in this file — every layer failed *silently*, reporting success or
> nothing rather than the thing it couldn't do.

> 🐛 **A new topic could orphan its own first conversation.** `onLive` records the session id on the
> pane, but that id arrives via the SSE `init` event a second or two after the first send. Close or
> reload inside that window and `openPanesMap` persists `{sid: ""}` forever, so the topic reopened on an
> empty "New chat" every time while the real conversation sat reachable only from the chat-switcher
> dropdown — indistinguishable from Bento having discarded it. `openProject()` now falls back to the
> recent-sessions default when *every* remembered pane is blank and the project does have chats, which
> self-heals the persisted entry on the next open. Guarded on "every pane blank" so an intentionally-kept
> blank pane in a multi-pane layout still survives.

---

## 5e. The shell — `app/page.tsx`, `components/BentoRail.tsx`, `components/Composer.tsx`

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

> 🐛 **A resize that silently didn't take.** `useSetting`'s setter was recreated on every render, so
> the divider's drag effect — which lists it in its deps — tore down and re-subscribed whenever any
> state changed. Collapsing to the rail mid-gesture is exactly such a change, and the width in flight
> was a local inside that effect, so it reset to the pre-drag value and `mouseup` committed the wrong
> number. Fixed on both sides: the setter is `useCallback`-stable (an unstable setter is a trap for
> every effect that depends on one), and the pending width moved to a ref that survives re-subscription.
> Caught while verifying the drag, not reported.

### The ask card — one question at a time, and one visible answer

`AskUserQuestion` arrives through the same `canUseTool` hook as a permission prompt (§3) and renders as
a wizard. Three rules, each of them a bug that was reported:

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

The footer states the outcome rather than the rules: `sending: <the exact strings that will be sent>`.
Anything the card can't answer honestly (an empty Other row) is dropped rather than sent as `""`.

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

### Composer
A `<textarea>` that grows to `MAX_H` (220px) and then scrolls, with a pixel-aligned mirror layer behind
it that tints markdown syntax without touching metrics (that constraint is why bold renders as dimmed
`**` rather than actual bold — a weight change would shift the text off the caret).

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

---

## 6. Account identity — `app/api/accounts`

**Never trust `token-slayer status`'s `active` field.** It echoes a label written on the last switch
*attempt*; it is not evidence the switch took.

> 🐛 **Silently billing the wrong account.** On 2026-07-29, `state.json` claimed
> `oedevai2@gmail.com` while the real OS-keychain credential was `pdtoan2811@gmail.com`. Every
> session that day ran on the wrong account with the CLI cheerfully reporting otherwise.

Ground truth is `~/.claude.json`'s `oauthAccount.emailAddress`, written by Claude Code from the
credential it actually authenticated with. `/api/accounts` layers a `live` block carrying that, plus
`offPreferred` and `claimsMismatch`. `AccountStatus` triggers on it and **re-verifies after
switching** rather than believing the CLI's reported success.

### Caveats
- `oauthAccount.displayName` goes stale across switches (read "OE Dev" while every UUID said
  `pdtoan2811`). Use the UUID/email fields; the display name is cosmetic.
- token-slayer's stored slot for a pooled account can be a **degraded capture** (`oauth_account`,
  `plan`, `refresh_token_expires_at` all null) *even while that account is live* — it then can't
  proactively refresh, so the silent-expiry outage recurs. Not fixable from this repo.

---

## 7. Module map — `lib/module-graph.ts`

The `/architecture` graph is **hand-maintained data, extracted from source**. Static edges come from
`from "..."` specifiers, runtime edges from `fetch()`/`EventSource()` string literals naming an
`/api/` path. The extraction script is in the file header — re-run it after a refactor.

> ⚠️ **This is the one thing here that can silently go stale.** Everything else describes behaviour
> that fails loudly when wrong; a missing edge just quietly isn't drawn. If you add a module, add it
> to `NODES`/`EDGES` in the same turn.

---

## 7b. The knowledge base itself

Four parts: the hub (`public/kb/index.html`), the visual explainer
(`public/kb/architecture.html`), this record, and the module map data. Ported from
`~/dataAnalyticsOwnego` (`toolkit/hub` + `queries/QUERIES.md` + the `query-docs` skill).

The pages share `kb.css` and `kb.js` rather than each carrying its own copy of the chrome. The
"one file, zero dependencies" rule that governs a *standalone artifact* is the wrong call here —
these pages ship together in one directory, and seven copies of 250 lines of CSS drift. Still zero
dependencies: no build step, no framework, no web fonts. Same call `~/dataAnalyticsOwnego` makes
with `toolkit/brand/tokens.css`.

**Page set** (`PAGES[]` in `index.html` is the only place to edit):

| Page | State |
|---|---|
| `architecture.html` — the whole system | shipped |
| `transcripts.html` — pipeline 1: disk → parser → tile | shipped |
| `live-sessions.html` — pipeline 2: browser → SDK → claude | shipped |
| `metrics.html` — pipeline 3: two machines, one collector | shipped |
| `operations.html` — deploy · identity · runbook | shipped |

**The page set is complete.** Every pipeline has a deep dive, plus a system overview and a runbook.

**Known gap:** `live-sessions.html` predates the browser panel rebuild (§5b) and says nothing about it.
The panel is a substantial part of pipeline 2 now — the result-text parsing, the two image sources, the
agent-driving toolbar — and it earns diagrams (the markdown-section parse, and the
inline-base64-vs-disk-file decision). Not written yet; §5b is the only record. No hub card has been
added for it, because there is no page to link to.

Every page carries the shared top nav (`KB.nav()`), so no page is a dead end and unwritten pages
show as visible-but-unclickable placeholders. **Light is the default theme**, deliberately — there is
no `prefers-color-scheme` rule, matching `~/dataAnalyticsOwnego`'s hub ("light by default"), so the
KB looks identical on every machine and screenshots of it are reproducible. Dark is opt-in via the
toggle and remembered across pages.

**Two ways to read it**, and the difference matters:

| | URL | Needs the app? |
|---|---|---|
| Served by Next | `localhost:3000/kb` | yes |
| Standalone | `localhost:4400` (`npm run kb`, or double-click `Open Knowledge Base.command`) | no |

The standalone server exists because `bin/serve.sh` tears :3000 down on every deploy and refuses to
restart while a turn is in flight — so the docs would be unreachable exactly when something is
broken, which is when you most want them. Zero dependencies, resolves its own root from
`import.meta.url`, walks the port up on `EADDRINUSE`.

The hub calls `/api/state` to learn which mode it's in. Only the standalone server answers; from
Next it 404s, and that failure *is* the signal that relative links already resolve. When standalone,
cards marked `needsApp` get rewritten to the app's real origin, or greyed out with "needs the app
running" if :3000 isn't listening.

> 🐛 **The KB server quietly stole the dashboard's port.** It read `process.env.PORT`, which is
> already spoken for here — `bin/serve.sh` sets it, and it's often exported in the shell. It bound
> `127.0.0.1:3000` *alongside* the dashboard's IPv6 wildcard (macOS permits that pairing rather than
> raising `EADDRINUSE`), so requests to `localhost:3000` split between two servers at random. Now
> reads **`KB_PORT`** only, and refuses to start if that equals the app's port.

---

## 8. Deployment

`bin/serve.sh` builds then swaps a **production** server on `:3000`, killing only the process bound
to that port. Production mode is deliberate: `next dev`'s Fast Refresh hot-patches the running page,
so using the dashboard to edit the dashboard's own code would change React's hook signatures
mid-session and crash the very tab driving the edit.

**The home page is local-only.** It reads `~/.claude/projects` and drives the local `claude` login,
so on Vercel it renders and finds nothing. Only `/dashboard` is remote-safe.

### The deploy has to outlive whoever asked for it

`serve.sh` alone is not usable from a chat pane, and a chat pane is where deploy requests actually come
from. That pane's `claude` is a *grandchild* of the `next-server` the script must kill, so an inline run
kills its own requester mid-sentence — and `serve.sh` would veto it first anyway, since the requesting
turn is itself "busy". The deadlock is structural: the caller can never be quiet while it is calling.

`bin/deploy.sh` breaks it by **detaching before waiting**. It walks its own process ancestry looking for
the PID bound to `:3000`; finding it means "I am inside the thing I'm about to kill", so it re-execs
itself into a new session (macOS has no `setsid` — it forks through `python3`'s `os.setsid()`, since a
plain `&` leaves the child in a process group a group-kill can still reach), then waits for the box to
go quiet, swaps, and verifies into `/tmp/minami-deploy.log`. Waiting rather than `--force` is what keeps
the deploy polite to *other* panes: `serve.sh`'s own veto still runs after the wait.

### `next build` is not a safe way to check that code compiles

`npm run build` writes `.next` **in place**, and the live server keeps its manifests in memory. So a
"harmless" verification build leaves a server handing out HTML that references CSS and JS hashes which
no longer exist on disk: every asset 400s, the page never hydrates, and the dashboard renders as
unstyled text stuck on "Reading local sessions…" — no tiles, no panes, no browser preview. It survives
a reload. Only a restart clears it.

Use **`npm run build:check`** (`NEXT_DIST_DIR=.next-verify next build`) instead. `deploy.sh` is the one
thing allowed to overwrite `.next`, because it restarts the server in the same breath.

> 🐛 **Verified the build, broke the dashboard — three turns running.** Each turn ended with a
> `npm run build` to prove the change compiled, then a detached deploy. The build desynced `.next` from
> the running server immediately; the deploy that would have repaired it waited for the box to go quiet
> and **aborted after 300s** because other panes stayed busy — so the box sat on a broken build with
> nothing in the log saying so. The `✋ still busy … aborting` line is not a warning that the app is
> fine; after a bare build it means the app is broken until a deploy actually lands.
> *Surfaced by user as "the browser preview is showing nothing".*

Two entry points, chosen by where you're standing — `docs/DEPLOY.md` is the protocol:

| From | Command | Why |
|---|---|---|
| A dashboard chat pane | `bash bin/deploy.sh --detach` | The requester dies with the server; detaching is mandatory. |
| Finder / Terminal | double-click `Redeploy Minami.command` | Not a child of the server, so it can run inline — and prompt `[w]ait / [f]orce / [q]uit` when panes are busy. |

**Verification is on facts, not exit codes.** The requesting session is dead by the time the swap lands,
so the log is the only witness — and "exit 0" is exactly the signal that lied in the 🐛 below. It asserts
the **server PID changed** (the old process is gone, not merely that *a* server answers) and reports
whether **`.next/BUILD_ID` changed** (unchanged is reported, not failed — you may have compiled no
change), plus `GET /` and `/kb`, plus a probe list. The useful assertion for "the new route exists" is
**anything that is not a 404** — `404` means the old build is still serving. A POST-only route answers
`400` *or* `405` to a GET depending on whether it validates the body or rejects the method, so probes
accept alternatives: `/api/fs/mkdir:400|405`. The defaults live in `bin/deploy.sh` itself;
`DEPLOY_PROBES` still overrides for one-offs (see the 🐛 in §10 for why the default moved into the repo).

### Gotchas
- `INGEST_TOKEN` genuinely gates metrics writes. `READ_KEY` ships as `NEXT_PUBLIC_*`, so it is
  compiled into the browser bundle — obscurity, not auth. Real privacy needs the deploy gated.
- **`npm install` prunes devDependencies when `NODE_ENV=production` is set in the shell** (it is, in
  this environment) — which silently removes `typescript` and `tailwindcss` and breaks the build.
  Use `npm install --include=dev`.

> 🐛 **A deploy can wait forever for a box that will never go quiet.** `deploy.sh --wait` polls
> `/api/agent/health` for `busy == 0` **across every session on the machine** — correct, since the
> restart kills all of them, but it means quiet is a property of the *box*, not the repo. A pane at
> `phase=awaiting` (a permission prompt or `AskUserQuestion`) is busy **forever**: `s.busy` clears only
> on a `result` message, and `canUseTool`'s promise never resolves until a human clicks. The auto-deny
> backstop in `lib/agent/manager.ts` doesn't help — it returns early at `if (s.subs.size !== 0) return`,
> so it only rescues panes with *no* subscribers (tab closed). An open tab sitting on a prompt is never
> rescued. Observed 2026-07-29: a deploy launched at 16:57 waited its full window while a blocked pane
> in `/tmp/minami-permtest` — an unrelated scratch folder — held the box busy. The deploy aborted having
> touched nothing, which is the safe outcome but reads exactly like "nothing happened". **Lengthening
> `--wait` makes the deadlock longer, not shorter.** Check for `phase=awaiting` *before* deploying —
> `.claude/skills/minami-flow/orient.sh` does this — and clear those panes first.

> 🐛 **serve.sh built successfully and swapped nothing.** Line 20 read `":$PORT…"`. Under a shell
> without a valid UTF-8 locale (`LC_CTYPE=UTF-8`, which macOS doesn't recognise) bash swallowed the
> multibyte `…` into the variable name, so `set -u` aborted the script — *after* the build, *before*
> the swap. The old server kept serving and the failure looked like a successful deploy. Fixed by
> bracing: `${PORT}`.

---

## 9. Concurrency — `bin/task.mjs`, and why two chats collide

**The condition:** every chat pane spawns a `claude` whose cwd is the *project folder*. Two panes on
one project therefore share a working tree, a branch and an index. Agent A's `grep` returns code
agent B is halfway through rewriting; whoever writes last wins, silently. Nothing in git or the SDK
prevents it.

It is not a rare edge case. Reconstructing one day (2026-07-29) from transcript timestamps:

```
054f88de  06:46:17 → 08:14:11   1040 rows
dedd6fc2  07:50:49 → 09:24:47    785 rows     ← 24 minutes of overlap
```

**5 overlapping pairs in that day alone.**

### The fix is isolation, not etiquette

`bin/task.mjs` gives each task its own **git worktree** — a second checkout of the same repository,
sharing the object store (the worktree's `.git` is a 4 KB pointer file), with its own branch, index
and files. Collisions stop being unlikely and become impossible.

```bash
node bin/task.mjs new browser-fix      # worktree + branch, prints its preview port
node bin/task.mjs list                 # branch · commits ahead · dirt · which have a live agent
node bin/task.mjs preview browser-fix  # build + serve on its OWN port; :3000 untouched
node bin/task.mjs merge browser-fix    # verify → build → merge into base (serialised)
```

Then point a chat pane at the worktree folder, and that agent physically cannot touch another's files.

**The merge is the point.** An overwrite in a shared checkout is not a conflict — it is a loss, with
nothing left to resolve. Moving integration to a merge is what converts silent losses into conflicts
git can reason about and you can fix.

### Gotchas
- **Ports are derived from the task name (FNV-1a → 3010–3049), never assigned round-robin.** A preview
  must land on the same port every time to be bookmarkable, and two tasks must not silently collide.
- **`node_modules` is symlinked from the base checkout**, not installed per task — a real install costs
  minutes and gigabytes, and a task is the same `package.json` by construction. The exception is a task
  that *changes dependencies*: delete the link and install for real.
- **Merge refuses when the base checkout is dirty.** That refusal fires constantly at first, because
  working dirty on the base branch is exactly the habit this replaces.
- **Merge refuses while an agent is live in the task** (via `/api/agent/live`), and is serialised on
  `/tmp/minami-merge.lock` so two merges can't interleave.
- Builds go to `.next-task`, never `.next` — so a preview build can never disturb the live server.

> 🐛 **Deploys had no mutual exclusion at all.** Two agents in this repo request deploys
> independently, and `next build` replaces `.next` **in place under the running server** — so two
> builds interleaving corrupt the directory the live process is reading, and the second swap can leave
> a PID serving a build that no longer exists on disk. There was no lock, no PID file, no check.
> `bin/deploy.sh` now takes an atomic `mkdir` lock (macOS ships no `flock`) with stale-holder recovery,
> plus an advisory pre-check *before* the detach fork — without that, the refusal is written to a log
> the caller can no longer read, and an agent is told "deploy running" for a deploy that declined.

> 🐛 **A deploy's own requester vetoed it.** Observed in `/tmp/minami-deploy.log`: a detached deploy
> waited 300 s for quiet, then aborted with `still busy (1 turn(s)) — waiting on your answer`. The
> blocking turn was **the agent that had asked for the deploy**, sitting on a question. The requester
> can never be quiet while it is waiting to be told what to do, so the wait-for-quiet strategy has a
> hole exactly when a deploy is requested interactively. Until the agent host moves out of
> `next-server` (see below), the workaround is to ask first and deploy last.

### What this does not fix

Sessions are still children of `next-server`, so a deploy still ends every conversation on the box.
The structural fix is to move `lib/agent/manager.ts` into a standalone daemon with the Next routes as
thin proxies over a socket — then deploying the UI stops killing chats, and the veto above stops
mattering. Not built.

---

## 10. Out-of-pane alerts — `bin/minami-event.mjs`, `lib/events.ts`, `components/NotificationBell.tsx`

**The condition:** the dashboard could already alert you — `lib/use-notify.ts` fires a native
notification plus a flashing tab title when a pane finishes a turn, needs approval, or asks a
question. But every one of those is produced *inside a React tree*, and the alert is deliberately
transient: suppressed while the tab is focused, and leaving nothing behind once it clears.

That covers none of the things that actually happen while you're away from the box:

| Event | Produced by | Previously visible as |
|---|---|---|
| Deploy live / verification failed | `bin/deploy.sh` (detached) | a line in `/tmp/minami-deploy.log` |
| Worktree build ✓ / failed | `bin/task.mjs build` | terminal scrollback of a pane you closed |
| Merge conflict on the base checkout | `bin/task.mjs merge` | ditto |

### Why it's a file, and why the server never writes it

The headline event is *"the deploy finished"* — and the deploy **restarts `next-server`**. Anything
held in the server's memory, or pushed down an open SSE stream, dies with the process that was
supposed to deliver it. The one moment you most need to be told something is the one moment the
messenger is guaranteed to be dead.

So the producer must **outlive** the server (a detached bash script appending to a file does), and the
consumer must be able to **catch up after reconnecting**. Hence:

```
deploy.sh ─┐
task.mjs ──┴─→ bin/minami-event.mjs ──→ ~/.minami/events.jsonl
                                              │  (read-only)
                          lib/events.ts ←─────┘
                                │
                     GET /api/events?after=<ms>
                                │
                     lib/use-events.ts (8s poll)
                                │
              NotificationBell + notify() toast
```

`bin/minami-event.mjs` is the **only** writer; `lib/events.ts` only reads. Nothing in the Next process
appends. As a side effect alerts are still recorded with `:3000` down entirely — the same property
`bin/task.mjs` deliberately has, for the same reason.

### Two cursors, both timestamps

`lib/use-events.ts` keeps two numbers in `localStorage`, and conflating them breaks the exact case the
feature exists for:

- **`notifiedTs`** — newest event already toasted.
- **`seenTs`** — newest event Thomas has actually *looked at* (set by opening the bell).

After a deploy the page re-mounts, refetches, and finds the "deploy live" event that landed while the
server was down. It must still be unread **and** must still toast — but not on the *next* remount. One
cursor cannot express that; two can. They're timestamps rather than an id set so the whole state is
two integers: two open tabs racing on the same key cost at most one suppressed toast, never a corrupt
list.

Timestamp cursors are also what make the log survive trimming. An offset/line-number cursor silently
rewinds by 100 events the moment `minami-event.mjs` rewrites the file, replaying alerts already read.

### Mechanics
- **Bounded log.** Trim to 500 when it crosses 600 — roughly one rewrite per hundred events. The
  rewrite is write-tmp-then-rename, so a reader never sees a half-written file; the cost is that an
  append landing inside the rename window is lost. A dropped alert is cheaper than a corrupt one.
- **Poll, don't stream** (`GET /api/events`) — an SSE stream would be severed at precisely the moment
  it had something to say. A poll just fails for a few seconds and catches up from disk.
- **REPLACE semantics**, matching activity state: the server's answer is the whole truth about the
  last 50 events, so no client-side accumulation can disagree with it.
- **Bodies are command output** — the verify table, the `tsc` error — rendered monospace with
  whitespace preserved. Reflowing them destroys the only thing they're good for.

### Gotchas
- **A brand-new browser profile has `notifiedTs = 0`, so the entire backlog looks fresh.** It's
  adopted silently instead of announced; nothing about a week-old deploy is news. The events still
  count as unread in the bell, which is `seenTs` — a different question.
- **Opening the panel *is* the acknowledgement.** There's no separate "mark read" to forget. A
  consequence: an event arriving while the panel is open is marked read immediately.
- `--verify-only` deliberately emits nothing. It's a manual probe, not an update.

> 🐛 **Every deploy on this box had been reporting "verification FAILED" while serving perfectly.**
> An ambient `DEPLOY_PROBES="/api/fs/mkdir:400,…"` was exported into the environment. `/api/fs/mkdir`
> is POST-only, so a GET answers **405**, not 400 — the probe list had gone stale against the routes it
> described. `deploy.sh` already supported `400|405` alternatives, but the *default* lived in an
> environment variable outside the repo, where nothing updates it when a route changes. Fixed by moving
> the default into `deploy.sh` itself (env still overrides for one-offs): a probe list is a fact about
> the repo's routes, so it belongs with the repo and moves when they do. Caught while wiring this
> section — a false "deploy failed" alert is worse than no alert, because it trains you to ignore the
> bell.

---

## 11. Images in a message — `lib/agent/images.ts`, `app/api/fs/paste`, `app/api/fs/image`

Paste a screenshot into the composer and Claude sees it in that turn.

### Everything follows from one decision: the payload is a PATH, not bytes

`Composer.tsx` states the invariant — *the textarea is the single source of truth for what Claude
receives* — and the attach button already honoured it by inserting a **path** ("inserts its path for
Claude to read"). Paste keeps that shape: bytes land on disk, the path goes into the text, and
`/api/agent/send` reads whatever image paths the outgoing message mentions and attaches them inline.

That one choice pays for itself four times:

- **No second source of truth.** Delete the path from the box and the attachment is gone; there is no
  separate pending-attachment state to drift out of sync with the text.
- **The attach button gets thumbnails and inlining for free** — by the time a picked file reaches the
  renderer it is indistinguishable from a pasted one.
- **No base64 crosses the wire from the browser.** The server reads the file it just wrote.
- **It survives a reload.** This is the load-bearing one — see below.

### Why an inline image block alone would have been a bug

`claude-sessions.ts` rebuilds a user turn from the on-disk JSONL by pulling out **text blocks only**
(`if (b?.type === "text")`). `Turn` has no image field. So an image block in a user message renders
live — the client still holds it — and then **vanishes on the next reload, reattach, or project
switch**, because the pane rebuilds from disk. `trimOutput` in `app/page.tsx` would strip it from
sessionStorage too, for the quota reasons recorded there.

A path is text. It survives the parser, so the thumbnail comes back. The image itself is re-derived
from the file — which is exactly why the pastes directory exists and why 24h is the right retention:
the model already got the picture inline at send time, so the file is a **rendering cache**, not the
payload. Losing it a day later costs a thumbnail in old scrollback, never the conversation.

### Mechanics
- **`~/.minami/pastes/`, not `<cwd>`.** `.playwright-mcp/` gets away with living in the project
  because the MCP server writes it and this repo's `.gitignore` covers it. The dashboard pastes into
  *every* topic's folder and cannot edit their gitignores. Chat input is not a project artifact.
- **`POST /api/fs/paste` takes no path input at all** — fixed root, server-generated filename. There
  is nothing for a caller to traverse with, unlike `/api/agent/browser/file` (client-supplied `cwd`).
- **Magic bytes, not extensions.** Both routes check the header bytes. Verified: a renamed
  `.env.local` with a `.png` extension is rejected 400.
- **Image first, then text** in the content array — the API's own vision guidance, and Claude attends
  to a question asked *after* the evidence more reliably than before it.
- **Content stays a bare string when there are no images**, so the parser, caches and on-disk history
  are untouched until an image is actually present.
- **Best-effort inlining.** A missing/oversized/fake image just isn't attached; the path stays in the
  text, degrading to exactly the old behaviour (Claude can `Read` it).
- **Only intercept a paste that carries an image.** Plain text must paste unchanged — a handler that
  swallows ordinary Cmd-V is far worse than no handler. Verified both ways.

### Gotchas
- **A bare path cannot express a space**, and the commonest image on a Mac is
  `~/Desktop/Screen Shot … .png`. The matcher therefore accepts a **quoted** path too, and the folder
  picker quotes any path containing whitespace. Without this the feature would fail silently — no
  thumbnail, no inline image, no error — on the exact file it will most often be pointed at.
- The path regex is duplicated in `lib/agent/images.ts` (what gets *sent*) and `app/page.tsx` (what
  gets *shown*). They must stay in step: a path that renders but isn't inlined, or vice versa, is a
  lie in one direction or the other.
- Caps are 5 images/message and 5MB each. The Anthropic API downsizes >1568px itself, so the cap is
  about not shoving tens of megabytes through a local request, not about token cost.

---

## 12. Rendering cost — why the dashboard made the machine hot

This app is open all day. Anything it does *per frame*, it does forever.

> 🐛 **The dashboard burned ~31% of a CPU core while sitting completely idle.** Reported as "lag and
> heat". It was not the polling, the parser or the SDK: `next-server` measured **1.5%**, and the
> browser's *renderer* process stayed ~6% throughout. The cost was entirely in the **GPU process** —
> compositing. Measured on an isolated headless tab (headless does no display compositing at all, so a
> real window is worse and drags `WindowServer` with it):
>
> | State | GPU process |
> |---|---|
> | All animations disabled | **0.0%** |
> | As shipped (before) | **31.1%** |
> | After removing two `backdrop-blur`s | **14.0%** |
> | …and `spin3d` also off | 6.6% |
>
> **The mechanism: `backdrop-filter` × any animated descendant.** A `backdrop-filter` element must
> re-blur everything beneath it whenever anything inside its box changes. Every live indicator — the
> pulse dot, the think-dots, the activity shimmer, the spinning icon — was a descendant of a blurred
> surface. A **1.5-pixel dot** pulsing at 60fps therefore re-blurred an entire 610×348 tile, and the
> think-dots re-blurred the **768×800** chat panel, sixty times a second, forever. Isolated: the same
> eight animations cost **30.6%** with the blur and **4.6%** without — a **6.6× multiplier**.
>
> **And it bought nothing.** `backdrop-filter` blurs what is *behind* an element. Behind these was a
> flat `body` colour and one very smooth radial gradient — and blurring a low-frequency image returns
> essentially the same image. The panel is a flex *sibling* of the grid, never over it. Verified with
> `elementsFromPoint`, and by screenshot.

### Rules that follow
- **Never animate inside a `backdrop-filter` subtree.** Not "prefer not to" — it converts a
  few-pixel animation into a full-surface re-blur every frame. If a surface needs blur, it must not
  contain anything that moves; if it contains something that moves, it must not be blurred.
- **Never put a CSS `filter` on an animating element.** A filter on an animating node can't be
  compositor-cached. Moving `drop-shadow` off the rotating icon onto its static wrapper cut `spin3d`
  from 45.2% to 18.6% for the same seven icons. The shadow no longer tracks the rotation — invisible
  at this size, and not worth a permanent tax.
- **`prefers-reduced-motion` is honoured**, which is both the accessibility answer and a real off
  switch — idle GPU goes to 0.0%. One-shot entrance animations are made instant rather than removed,
  so elements that animate *in* don't get stranded at `opacity: 0`.

### The cost of animation is a FIXED per-frame tax, not a per-element one

The second audit measured the shape of the cost directly, on the shipped build, by varying only the
number of animated elements on one page:

| Animated elements | GPU | Renderer | Total |
|---|---|---|---|
| **0** | 0.6% | 0.7% | **1.3%** |
| 1 | 8.8% | 3.8% | **12.6%** |
| 4 | 9.2% | 4.1% | **13.3%** |
| 41 | 10.1% | 7.0% | **17.1%** |

**0 → 1 costs 11.3 points. 1 → 41 costs 4.5 more.** You are paying for the existence of a 60fps frame
loop, not for what is in it. Three consequences, all counter-intuitive enough to be worth stating:

- **Optimising an individual animation is close to worthless.** `will-change` was measured twice and
  did nothing — on `spin3d` (33.8% → 33.2%) and on the pulse dots (9.2% → 8.8%). Both inside noise.
- **Reducing the NUMBER of animated elements is close to worthless.** One dot costs what four do.
- **The only move that pays is going to zero.** Anything that animates permanently costs the same as
  everything animating permanently.

> 🐛 **One "review" badge held the whole tab at ~12.6% CPU forever.** The tile's status dot pulsed when
> `p.active` (touched in the last 2 minutes) *or* `p.review` — and `review` is a standing state that
> persists for days. So on a board with any project awaiting review, the page never reached zero
> animations, and never dropped to the 1.3% floor. `spin3d` had the same bug via `active={p.active}`,
> tumbling for two minutes after a turn ended. Both now key off `la` / `busy` — a turn actually in
> flight, a signal the code already computed one line below. **A pulse should mean "this is happening
> now"; a standing state gets a static dot.**

### Also measured, and NOT the problem
Ruled out by experiment, so nobody re-investigates them:
- **Server cost per pane is negligible.** `next-server` went 2.48% → 3.17% for four extra panes —
  **0.17% per pane** — while absorbing ~190 requests/min per tab. The incremental parser and its
  caches are doing their job; polling frequency is not worth tuning.
- **React re-rendering from polls is ~2 points.** Silencing *every* poll endpoint moved the renderer
  only 14.5% → 12.6%. The renderer's idle cost is animation frame work, not reconciliation.

### Measured and rejected
**Layer promotion (`will-change: transform` + `backface-visibility: hidden`) on the icons does
nothing here** — 33.8% → 33.2% for a fixed 12-icon workload, inside noise. The residual `spin3d` cost
is per-frame compositing of the 3D layers themselves, not re-rasterisation, so promotion only adds
memory. Recorded because it is the obvious next thing to try, and it doesn't work.

### How to measure this again
`ps -o time=` deltas over a fixed interval, **not** `%CPU` — macOS `%CPU` is a decaying average and
bleeds previous state into the next sample. Drive one isolated headless tab, then A/B by injecting
CSS at runtime into the *same* page and process; the live data changes the animation count between
page loads, so comparing two loads is not a controlled experiment.

---

## The pattern behind the incidents

Six of the eight bugs above are the same mistake in different clothes: **trusting a signal that looks
authoritative but is only a claim.** An mtime. A CLI status label. A reported switch success. A
connection that reopened. A build that exited 0.

The recurring fix is to find the thing that cannot lie — a content hash, the credential itself, a
timestamp comparison, an actual HTTP probe — and check that instead.

---

## Changelog

### 2026-07-29
- **Idle animation cost cut to the floor: a pulse now means "happening now"** (§12) — second perf
  audit. Measured that animation cost is a **fixed per-frame tax**, not per-element: 0 animated
  elements = 1.3% CPU, 1 = 12.6%, 41 = 17.1%. So one permanently pulsing dot costs what forty do — and
  the tile's `review` badge (a standing state, not an event) plus `spin3d`'s 2-minute `p.active` window
  meant the page never reached zero animations. Both now key off a turn actually in flight. Verified:
  zero animations at idle where there were always ≥1 before. Also ruled out by experiment — server cost
  is 0.17%/pane across ~190 req/min, and React re-render from polls is ~2 points; `will-change` does
  nothing (tested twice). *Requested by user: "audit for more optimization … with surgeon knife and
  clear approaches and hypothesis".*
- **The dashboard was burning ~31% of a CPU core while idle** (§12) — reported as "lag and heat".
  Not the polling, parser or SDK (`next-server` measured 1.5%): it was `backdrop-filter` re-blurring a
  whole tile / the 768×800 chat panel every frame because a 1.5px indicator dot was animating inside
  it. Same animations cost 30.6% with the blur and 4.6% without — a 6.6× multiplier — and the blur was
  visually inert, since behind it was a flat colour and a smooth gradient. Removed from both
  containers, moved `drop-shadow` off the rotating icon, and added `prefers-reduced-motion`. Measured
  A/B in the same page and process: **GPU 31.1% → 14.0%**. Layer promotion was tried and rejected
  (33.8% → 33.2%, inside noise). *Reported by user: "lag and heat on my local machine".*
- **Audit of continue-on-open — four defects fixed, and the feature actually exercised** (§5e). The
  candidate is now scoped to `s.cwd === cwd` (a topic is keyed on `basename(cwd)`, so same-named folders
  share one); the two-writers guard claims the id at spawn instead of at `init`, closing a 1–2s window
  where two panes could both pass it; a refused resume now hands the id back through `onLive("")`, since
  undoing it locally left the parent still latched; and the copy no longer claims "where you left off"
  when the date-window chip may have hidden something newer. Verified on the preview rather than by
  inspection: a resumed pane answered a question only the earlier conversation could answer
  (`cat probe.txt`), the chat count stayed at 7 so nothing forked, and two concurrent rival resumes of
  the same not-yet-live session ended with exactly one accepted.
  *Requested by user: "audit the resume automation".*
- **Blank chat panes continue the topic's last conversation** (§5e) — `claude --continue` parity. A
  blank pane used to start a session that could see none of the project's history. It now names the
  chat it will pick up before you type (with `Start fresh instead`), draws a seam in the transcript
  once it has, and refuses to resume an id that's live in another pane — two subprocesses appending to
  one JSONL corrupts it in a way no reconcile can undo.
  *Requested by user: "auto resume session like in claude cli for consistent context and chat".*
- **Paste an image straight into the composer** (§11) — `lib/agent/images.ts`, `app/api/fs/paste`,
  `app/api/fs/image`. The payload is a **path**, not bytes, which preserves the composer's
  single-source-of-truth invariant and gives the attach button thumbnails and inlining for free. An
  inline image block alone would have been a bug: `claude-sessions.ts` keeps only text blocks when it
  rebuilds a user turn, so the image would render live and vanish on the next reload. Verified: 64×64
  PNG round-trip byte-identical, renamed `.env.local` rejected on magic bytes, traversal rejected,
  plain-text paste untouched, quoted paths with spaces matched. *Asked for by user: "I want to copy
  and paste image straight to the chat panel input".*
- **`task.mjs new` branches from committed HEAD, so a dirty base yields a stale worktree** — recorded
  in the `minami-flow` skill. With 47 uncommitted files in the base, a fresh worktree was missing that
  day's entire body of work. A worktree built on a stale base is worse than none: it looks correct.
- **The `:focus-visible` ring stopped painting a pink rectangle on the composer** (§5e) — a regression
  from the interaction pass below, caught the same day. `:focus-visible` matches a text field on a
  plain mouse click, and the ring being *unlayered* beat the composer's `outline-none` in
  `@layer utilities` regardless of `:where()`'s zero specificity. Text fields are now out of the
  selector; `border-radius: inherit` went with it.
  *Reported by user: "when I click on chat panel - a pink rectangle show up".*
- **The empty composer stopped sizing itself to its placeholder** (§5e) — `scrollHeight` on an empty
  textarea measures the wrapped placeholder, so idle inputs in narrow panes ballooned to three lines
  (68px → 23px after the fix). Wrapped inline-code chips also no longer render as one box torn in half
  (`box-decoration-break: clone`, in both the composer's tint layer and the message renderer).
  *Reported by user: "weird box wrap in chat input".*
- **Front-end interaction pass** (§5e) — one motion vocabulary (4 durations, 2 curves, Tailwind's
  defaults retuned to match), `transition-all` eliminated tree-wide, `prefers-reduced-motion` and
  `:focus-visible` honoured for the first time, pin-aware chat scroll with a "jump to latest" return
  path, the browser splitter taken off React/localStorage per pixel, and `TurnRow` memoised (12
  scroll-driven state changes: 20 row renders instead of ~900).
  *Reported by user: "code refactor on front end for snap and smooth interaction — matching the open
  source standard".*
- **Permission modes are real now, and bypass is the default** (§3) — the composer's pills changed
  nothing on an already-running session while reporting success; the mode is now enforced by the
  server's own `canUseTool` and the route answers honestly. `bypassPermissions` is the shipped default
  for this box (`MINAMI_DASHBOARD_PERMISSION_MODE` to override), exposed in Settings → Chat.
  *Reported by user: "set bypass permission as default across the minami board - check if the
  permission pill click are actually effective".*
- **`minami-flow` skill: when to isolate, merge, deploy and resolve conflicts** —
  `.claude/skills/minami-flow/`, with a read-only `orient.sh` preflight. CLAUDE.md is thin and shaped
  for prohibitions; KNOWLEDGE.md holds the reasoning but nothing reads a reference doc unprompted.
  The missing piece was *judgment at the two moments it's needed* — before the first edit, and before
  shipping. Built on the observation that **state in this repo is invisible from inside a pane**: every
  collision so far was found by accident (a file changing under an open editor, a lock refusing a
  command, a deploy timing out), and all were one command away. Gates are commands with a pass/fail,
  not judgment calls; every failure path is an action, and the single escalation point is a *semantic*
  merge conflict. *Asked for by user: "need a skill … to know when to do those things".*
- **A deploy can starve on a pane blocked at a permission prompt** (§8 🐛) — quiet is box-wide, and
  `phase=awaiting` never clears itself. Found live while writing the skill.
- **Out-of-pane alerts: deploys, worktree builds and merges now reach you** (§10) — a disk-backed
  event log (`bin/minami-event.mjs` → `~/.minami/events.jsonl`) plus a bell in the header carrying the
  real bodies (the verify table, the `tsc` error). The existing `notify()` path only covers events
  produced *inside a React tree* and is transient by design, so a detached deploy could only ever
  report itself into a log nobody was tailing. A file is the only transport that survives the deploy
  that produces it. *Asked for by user: "get me a notification … when there is updates on worktrees
  waiting to be go up to production, build success etc".*
- **Every deploy was reporting "verification FAILED" while serving perfectly** (§10) — a stale ambient
  `DEPLOY_PROBES` pinned `/api/fs/mkdir` to 400, but a POST-only route answers 405 to a GET. The probe
  defaults now live in `deploy.sh`, where they move with the routes they describe.
- **The ask card stopped lying about what it would send** (§5e) — "Other" is now a row in the option
  list rather than a separate input, so exactly one thing is highlighted and it is the thing that gets
  sent; single-select used to keep the chip and silently discard the typed text. Multi-select is
  declared in words and in the control's shape (checkbox vs radio) instead of a 10px footer hint, and
  options are strictly one per row — the wrapped chip layout reordered itself at narrow widths.
  *Reported by user: "I chose one above, it highlight and I can also input on the other option" +
  "sometimes multiple choice option is available but I have no way to know" + "The option need to be
  strictly vertical".*
- **Task isolation: one worktree, one branch, one agent** (§9) — `bin/task.mjs new/list/preview/merge/rm`.
  Two chats on one project shared a working tree and overwrote each other silently; the transcripts show
  **5 overlapping pairs in a single day**. Verified: an edit in a task worktree leaves the base checkout
  untouched, and merge refuses on a dirty base, a dirty task, or a live agent.
  *Reported by user: "I ask 2 chats at the same time to fix or add changes to minami-dashboard".*
- **Deploys are now mutually exclusive** (§9) — there was no lock at all, and `next build` replaces
  `.next` in place under the live server. Atomic `mkdir` lock with stale-holder recovery, plus a
  pre-detach advisory check so the refusal reaches the caller instead of only the log.
- **Permission mode is per session, not global** (§5e) — it was one localStorage key for every pane
  while `changeMode()` applies per session on the server, so setting bypass in one chat flipped every
  other chat's badge, and the badge could describe a session other than the one executing.
  *Reported by user: "the session is not consistent by chat somehow".*
- **`useSetting` leaked values across keys** (§5e) — on a key change with nothing stored under the new
  key it kept the previous key's value, so switching to a chat with no saved draft showed the draft
  from the chat you just left. Now resets to the default. This is what made per-session keys viable.
- **Panes warn when they share a folder** (§9) — "N agents are live in this folder", from
  `/api/agent/live`, which already carried `cwd`.
- **The browser preview was blank for every named screenshot** (§5b) — `/api/agent/browser/file` only
  looked in `<cwd>/.playwright-mcp/`, but `browser_take_screenshot` with an explicit `filename` saves
  to the session root *and* omits the inline image, so the panel had no source at all. It now checks
  both locations under the same allowlist.
  *Reported by user: "the browser preview is showing nothing when Minami Dashboard use it".*
- **`npm run build:check`** (§8) — a verification build that targets `.next-verify` instead of
  overwriting `.next` under the live server, which is what had been leaving :3000 serving an unstyled,
  never-hydrating page. `CLAUDE.md` now forbids the bare build. `deploy.sh` route probes accept a list
  (`400|405`), so a POST-only route no longer fails an otherwise-good deploy.
- **Transcript history is reachable end to end** (§1) — turns are read as addressable *windows*
  instead of a fixed 1.5 MB tail + `slice(-120)`, and `/api/bento/session/[id]?before=<byteOffset>`
  serves the page before any offset. History pages are immutable, so each is read once and cached
  forever; the live tail is folded incrementally like meta. Verified by walking two real transcripts
  to offset 0: **863 turns in 6 pages** and **1813 turns in 11 pages / 0.6 s**, both matching an
  independent full parse exactly, no gaps or overlaps.
  *Reported by user: "the older history log transcript is not accessible for some chat or session —
  where it should show load old message".*
- **The "Show earlier messages" button no longer lies** (§1, §5e) — it revealed only already-fetched
  turns, then disappeared at the window edge as though the conversation started there. It now falls
  through to fetching from disk. Also fixed: the render `limit` never reset on session switch, so
  opening a short chat after expanding a long one rendered hundreds of messages at once.
- **The turns disk cache stopped being a hot-path cost** (§2) — was a synchronous 7.9 MB write on
  every reparse (i.e. every 2.5 s of a live session); now throttled to 15 s and budgeted by
  serialised bytes. **7.9 MB → 251 KB.**
- **`bin/transcript.mjs`** (§1) — read any transcript in full from the terminal, with the app down.
  `list` / `show`, with `--tail/--head/--since/--grep/--tools` and text · md · **JSONL** output for
  token-slayer and `jq`. 1813 turns out of a 64 MB file in 0.25 s.
- **Rail is a full-height weighted strip with hover-out names** (§5e) — chip heights are now a
  `log1p`-compressed share of the measured column height instead of three fixed sizes, so the strip is
  always exactly full and reads as relative weight; hovering slides the names out over the chat
  without moving it. Dragging the divider no longer routes through React (straight to `--lw`/`--rw`,
  committed on mouseup) and snaps to the rail on the frame it crosses 260px.
  *Reported by user: "clunky interaction for dragging like that - need refine to snap right away" +
  "I want the bento strip to be full vertical … with weight ratio of each bento scale accordingly" +
  "need a subtle hovering to show title for easier context switching".*
- **Topic icons actually distinguish topics** (§5e) — the `cube` catch-all is gone; icons are assigned
  across the whole visible set with collision fallback, the keyword table doubled, and
  `~/.minami-bento/icons.json` now carries a hand-assignable `icon` per project (the `bento-icons`
  skill documents it). Plus a `useSetting` setter-identity bug that was quietly discarding drag
  results.
- **One-command redeploy shipped** (§8) — `bin/deploy.sh` (wait-for-quiet → swap → verify, auto-detaches
  when its caller is a descendant of the server it's killing), the double-click
  `Redeploy Minami.command` for Finder, and `docs/DEPLOY.md` as the protocol. Success is now judged on a
  changed PID and `BUILD_ID` rather than exit 0 — the signal that lied in the §8 🐛.
  *Reported by user: "get me a .command file and a protocol that I can ask minami dashboard to redeploy."*
- **New topics can actually be created** (§5d) — three stacked bugs meant there was no working path from
  "＋ New topic" to a tile: the picker let you select a non-existent folder, `api/agent/send` never
  validated `cwd` (so the SDK spawn died silently, producing nothing at all), and `isTrivial`'s
  `messages < 3` hid the resulting session until its third message. Added `POST /api/fs/mkdir` plus a
  "Create this folder" / "＋ folder" affordance, a `cwd` stat check that returns a readable 400, and a
  freshness exemption so a just-made topic is always visible. Also fixed a new topic orphaning its own
  first conversation when reloaded within a second of the first send.
  *Reported by user: "I am having a chat in the second brain bento that should populate the topic
  ownegogrowth with it dedicated folder on my local machine — check why minami bento cant create such
  topic and fix."*
- **Reasoning is now typeset, not dumped** (§5c) — `Markdown` gained a `tone` (`chat` | `thought`) and
  a `caret` prop, so the thought block runs through the *same* parser as the answer, one contrast step
  back: paragraphs, lists and bold lead-ins survive instead of collapsing into one italic wall.
  `ThoughtBlock` moved out of `app/page.tsx` into its own component, and `manager.ts` now emits a
  `\n---\n` seam between thinking passes (new turn-scoped `sawThinking`) which the block renders as a
  numbered divider. Collapsed, the disclosure states its pass and word count.
  *Reported by user: "thought process print also need proper typography and divider of some sort to
  have better readability".*
- **Browser panel rebuilt** (§5b) — from a fixed 300px column showing the latest screenshot to an actual
  browser window: agent-driving toolbar (URL bar, back/forward/reload, device presets, record), status
  strip, screenshot filmstrip with a live/pinned split, console + network + actions drawer, drag-resize,
  side ↔ stacked layout, a pop-out window at `/browser/[id]`, and a real lightbox with zoom/pan and
  arrow-key stepping. All of it derived from tool results already on the wire — new `lib/browser-view.ts`
  is pure and shared by every surface. Three bugs recorded in §5b, including a "view full size" link
  that had **never** worked (Chrome blocks top-level `data:` URL navigation).
  *Reported by user: "I can click on to the browser preview to view it larger" + "matching the Claude
  Code browser UI UX and use cases".*
- **Claude Code parity, where it earns it** — researched the `claude` v2.1.220 binary: it has no browser
  panel at all, because it drives your real Chrome. So the *panel* is a deliberate divergence, while its
  permission prompt (verb phrase + host + session-scoped allow-all) and compact transcript arg summaries
  were ported. `--caps=devtools` added to the MCP spawn so video recording exists; a screenshot nudge
  added to the system prompt so the panel isn't blank while Claude reads accessibility trees.
- **KB page set complete** — `metrics.html` (6 sections) and `operations.html` (4 sections) shipped,
  finishing all five pages. Metrics records the `JSON.parse("null")` process crash, the absent
  retention policy, the two hand-synced price tables and the 2026-09-01 Sonnet pricing cliff.
  Operations is the runbook, and states the pattern behind nearly every incident here: a signal that
  looked authoritative but was only a claim.
- **UI corrected against the rendered original** — served `~/dataAnalyticsOwnego` and compared side by
  side rather than reading its CSS. Added the leading rule on section eyebrows, moved step narration
  above its diagram, and gave the hub its action card, metadata strip, card footer lines and centred
  closing line. One deliberate divergence kept: their sticky rail paints over full-bleed panels, ours
  doesn't.
- **KB navigation + light-mode default** — shared sticky top nav on every page via `KB.nav()`;
  `architecture.html` migrated off its duplicated inline CSS onto `kb.css`/`kb.js`; light is now the
  default theme with no `prefers-color-scheme` rule, matching dataAnalyticsOwnego's hub.
  `live-sessions.html` shipped (7 sections, 3 diagrams) — including the restart/drain mechanism and
  the drain-endpoint auth reasoning, neither of which was recorded here before.
  *Reported by user: "implement the navigation ... match 1-1, also light mode as detail."*
- **KB moved onto a shared shell** — `kb.css` + `kb.js` extracted, hub rebuilt on it, and
  `transcripts.html` added as the first deep-dive page (7 sections, 3 diagrams). Page set now
  declared up front in the hub with honest "not written yet" placeholders. The six-phase build
  workflow is recorded in the `visual-explainer` skill.
  *Reported by user: "change the whole KB to match the dataAnalyticOwnego UI UX and detail in each page."*
- **KB runs standalone** — `public/kb/serve.mjs` (`npm run kb`, or the double-click
  `Open Knowledge Base.command`) serves the knowledge base on :4400 independently of the dashboard,
  so it stays readable while :3000 is down. Uses `KB_PORT`, never `PORT` — see the 🐛 in §7b.
  *Reported by user: "I want a way to open that KB on localhost — as an independent app."*
- **Knowledge base created** — `public/kb/` hub, this record, and the `minami-kb` skill that keeps it
  in sync. Format borrowed from `~/dataAnalyticsOwnego`'s `QUERIES.md` + `toolkit/hub`.
- **`/architecture` module map shipped** — React Flow, edges extracted from source.
- **Architecture explainer shipped** — `public/kb/architecture.html`, ten sections, five interactive
  diagrams, zero dependencies.
- **`bin/serve.sh` fixed** — brace `${PORT}` so a non-UTF-8 locale can't abort the swap silently.
- **Account alert shipped** — triggers on `~/.claude.json` ground truth, not the token-slayer banner.
  *Reported by user: "alert me whenever I'm back on pdtoan2811."*
- **Live sessions moved to Opus 5** with effort left at the SDK default (was Opus 4.8 `--effort high`).

### 2026-07-28
- Two stability-audit passes (`6505ed2`, `7832775`) — incremental parser, cache thrash fix, atomic
  cache writes, orphaned-prompt handling, `stop()` race, process-level rejection handlers.
- Reconnect fix (`44b26fb`) — treat a bare `EventSource` reopen as an explicit re-attach.
- Hints + browser tool (`ded5cdb`) — cold-start vs mid-turn status, TodoWrite checklist, Playwright
  MCP browser with a live screenshot panel.

### 2026-07-27
- Bento reworked to Project › Goal › Task; 29 MB transcript parse 9.3 s → 39 ms; cold launch → 8 ms.
- Cross-machine metrics shipped — self-hosted collector + Tailscale Funnel; deploy moved to Vercel.
