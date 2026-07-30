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

> 🐛 **A new topic could orphan its own first conversation.** `onLive` records the session id on the
> pane, but that id arrives via the SSE `init` event a second or two after the first send. Close or
> reload inside that window and `openPanesMap` persists `{sid: ""}` forever, so the topic reopened on an
> empty "New chat" every time while the real conversation sat reachable only from the chat-switcher
> dropdown — indistinguishable from Bento having discarded it. `openProject()` now falls back to the
> recent-sessions default when *every* remembered pane is blank and the project does have chats, which
> self-heals the persisted entry on the next open. Guarded on "every pane blank" so an intentionally-kept
> blank pane in a multi-pane layout still survives.

---
