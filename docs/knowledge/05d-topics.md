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
