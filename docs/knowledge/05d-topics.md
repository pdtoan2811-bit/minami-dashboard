# Creating a topic

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

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
- The picker has **two tabs**: **Recent** (default) and **Browse** (the filesystem walk above). File
  mode (`pickFiles`, the attach picker) has no tabs and is untouched.

### The Recent tab — `lib/topic-rank.ts`

Browsing to a folder is the honest way to reach a *new* topic, and it was the wrong default for the
common one: nearly every "new topic" is another chat in a folder you already work in, so the frequent
case was paying the rare case's price — a directory walk from `~`, every time.

**Ranking is the whole feature; a list is easy, the right five rows are not.** Two obvious orderings
both fail:

| Ordering | Why it fails |
|---|---|
| Last activity | One throwaway question in `~/Downloads` five minutes ago outranks the project you've lived in for three weeks. This is the "noise" complaint verbatim. |
| The board's `weight` (`reqs + tokens/5000`) | A lifetime total — a project you finished last month sits at the top forever. |

So the score is **depth, decayed by age, plus a term for whether you came back**:

```
score = (log1p(reqs + tokens/5000) + 1.6 × log1p(days − 1)) × 0.5^(ageDays / 7)
```

`days` is distinct **local** calendar days with activity. Returning on separate days is the strongest
evidence a topic is real work rather than a one-off, and it's the term that sorts *focused* above
*busy once*: a single frantic afternoon in a scratch folder can out-message a real project, but it
cannot out-return one. Log scaling matters because the top topic here is ~40× the median by volume —
on a linear scale nothing else would ever place.

Three filters do what no score term should:
- **`MIN_REQS` (6)** — a floor, not a term, because no amount of recency should promote a 2-message
  folder, and a floor is explainable in a way a threshold buried in a polynomial is not.
- **Transient roots** (`/tmp`, `/private/tmp`, `/var/folders`) and **`$HOME` exactly** — excluded
  outright. The OS deletes a temp dir, and `$HOME` is this app's *folderless* case ("No folder →"
  starts a session there and labels it `CLI`), so it surfaces as a topic named after the user —
  `thomas` — which is an artifact of `basename(cwd)`, not a project anyone chose. Measured: without
  these, two `/private/tmp/minami-smoke/*` fixtures and `~` took three of eight slots.
- **`RELATIVE_FLOOR` (0.2 × the leader)** — the limit is a ceiling, not a quota. A box with three real
  projects offers three rows rather than padding to eight with folders you're done with.

Each row states *why* it ranked there ("4 chats over 3 days"), because an order the user can't
account for reads as arbitrary — and this one is a formula, so it owes an explanation.

### Gotchas (Recent tab)
- **Rank over `allProjects`, never `projects`.** The search box and the date-window chip are view state
  for the *board*; letting either decide what "where do I work" offers means a 24h window hides the
  project you opened the picker to reach. Same rule, same reason, as the open panel (below).
- **`rankTopics` takes `now` as an argument.** Pure and injectable so it can be unit-tested and so two
  calls in one frame can't disagree about the clock.
- Recent is the default **only when it has rows** — a fresh install must not open on an empty panel
  with the real picker hidden behind a tab.
- Clicking a row calls the same `startTopic(cwd, name)` as Browse, so an existing topic goes through
  the ordinary `newTopic` → real-project handover below and arrives with its `--continue` offer intact.
- **The dialog is a fixed `h-[70vh] max-h-[34rem]`, never `max-h`.** Sized to its content it changed
  height on every tab switch and every step into a differently-sized folder — and a *centred* box that
  changes height also moves, so the row under the cursor slid out from under it and the tab you were
  aiming at drifted mid-click. One dimension for every state; the list inside scrolls. The rem cap
  stops a tall monitor stretching it into a column of empty space. Measured identical (top 128,
  544×512 at 1280×800) across Recent, Browse, and a two-entry folder.
  *Reported by user: "consistent size of popup please".*

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

### A topic ends when it becomes a real one

`newTopic` is scaffolding, not a mode. It holds the panel together between "you picked a folder" and
"a session exists there", and it must be **handed over** the moment the board has a real project for
that cwd — matched on `cwd`, not on name, because the picker can label a topic something other than
its folder (`"CLI"` for a folderless session in `$HOME`) while a topic's name is derived as
`basename(cwd)`. The handover deliberately leaves `panes` alone: a blank pane is a chat you are about
to start, not a gap to fill, and replacing it with the folder's recent chats would hijack "new chat in
a folder that already has some" — the ordinary case for the ＋ tile.

### The board is a VIEW; the open panel is not

`projects` is filtered by the search box, the date-window chip and `isTrivial`. The open panel must
never be resolved out of it — see the post-mortem below. `groupProjects()` runs over both the filtered
list (what the board draws) and the unfiltered `pool` (what the panel resolves against) so the two
cannot drift.

> 🐛 **Three ways the chat panel closed itself, and one that lost the way back.**
> *Reported by user: "new chat … keeps changing topic title, close on its own and lose the history."*
> All four reproduced against the running server before being touched.
>
> 1. **Escape was the most destructive key in the app.** The window-level handler checked `Escape`
>    *above* its own input/textarea guard, so pressing it with the caret in the composer tore down the
>    whole panel — measured, with a half-typed draft in the box. `closePanel()` also clears the
>    persisted `openPanel`, so a reload afterwards came back to the board rather than the conversation.
>    On a Vietnamese keyboard this is not a slip: Escape is how you dismiss an IME candidate list, so
>    the key you press *while writing a message* threw the message's window away. Four claims now
>    outrank the panel, in order — `defaultPrevented`, `isComposing`, a focused text field, an open
>    overlay. `FolderPicker` gained its own capture-phase handler (the pattern `BrowserLightbox`
>    already used), which covers the attach picker too: that was one keystroke from "attach a file" to
>    "the conversation is gone".
> 2. **Filtering the board unmounted the conversation.** `proj` was looked up in the *filtered*
>    `projects`, and the search box and date chip render **while a panel is open**. So typing four
>    letters in Search deleted the panel — every pane in it, mid-turn, with no close action and nothing
>    to say why. Reproduced exactly that way.
> 3. **A failed poll did the same thing for one tick.** `setSessions(d.sessions || [])` treated an
>    `{error}` response as an empty board. It now holds the last good list unless the response actually
>    carries an array.
> 4. **A new topic never became the real one.** `newTopic` has a permanently empty `sessions` array, and
>    nothing retired it — so the board grew a proper tile for the folder while the panel stayed in
>    ad-hoc mode: the chat switcher listed nothing, the ＋ menu offered no chats, `continueTarget` was
>    always null, and a refresh restored a topic panel with **no route back to the conversation it had
>    just started**. That is the shape of "it lost my history": the transcript was on disk and reachable
>    from the tile the whole time, but not from the panel actually open on it.
>
> The common thread is worth more than the four fixes: each one is a **view concern reaching into
> state**. A filter decided what existed, a keystroke aimed at a textarea reached the window, a failed
> fetch was read as data, and a piece of scaffolding outlived what it was scaffolding.

> 🐛 **A new topic could orphan its own first conversation.** `onLive` records the session id on the
> pane, but that id arrives via the SSE `init` event a second or two after the first send. Close or
> reload inside that window and `openPanesMap` persists `{sid: ""}` forever, so the topic reopened on an
> empty "New chat" every time while the real conversation sat reachable only from the chat-switcher
> dropdown — indistinguishable from Bento having discarded it. `openProject()` now falls back to the
> recent-sessions default when *every* remembered pane is blank and the project does have chats, which
> self-heals the persisted entry on the next open. Guarded on "every pane blank" so an intentionally-kept
> blank pane in a multi-pane layout still survives.

---
