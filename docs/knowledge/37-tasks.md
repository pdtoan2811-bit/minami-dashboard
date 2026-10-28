# §37 · Home and threads — Ask · Needs you · Where you left off · Today

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

**Status (2026-10-28):** built in worktree `task/chat-8`, previewed on `:3001` (`npm run dev:iterate`).
**Not merged and not deployed** until Thomas says so. The tree is left uncommitted on purpose, because
the merge autopilot skips dirty trees (§13).

## How it got here (same day, three rounds)

1. **Task layer** (pitch minami-tasks F2): Topic › Task › ★ Lead › ↳ sub-sessions with a Definition of
   Done, on its own `/tasks` page with its own chat. Thomas: use the bento's chat panels, keep `/`.
2. **The same thing inside the bento**: a task bar row, ★/↳/💬 tab marks, a tile chip, proposal cards,
   and roles in the system prompt. Thomas: "weird".
3. **A debate** (workflow: one evidence miner over 14 days of transcripts, three stances, a cross-critique,
   a judge; verdict in `~/ecvision/pitches/minami-tasks/DEBATE-verdict.md`). The evidence:
   - 71% of sessions are machine-made
   - 18% are one-tap Today/Autopilot hand-offs, 83% of them with a single message
   - next-day resumes land 08:00–11:00
   - 12% of his messages are numbered multi-asks
   - 64 messages named another project
   - the phone is 14% of opens, nearly all in the morning.

   The build asked for structure before it gave anything back, so the morning list was empty exactly
   when it was needed. **This file describes round 3.** Rounds 1 and 2 are gone from the code.

Thomas's answers to the verdict's questions:
- a thread's first session is enough, with no lead chat
- Minami suggests a done-list and he taps to accept it
- a message that names another project stays where he typed it, with a one-tap move.

## What's on `/`

Above the tiles, in this order (desktop: in the bento column with no panel open; phone: the default
"Home" view, with Inbox one tap away):

| Section | What it is |
|---|---|
| **Ask line** | Type anything. A chip shows the project it will land in *before* sending: your pick, else the project the text names (`guessProject`), else the newest thread's. A numbered list of 2+ asks shows **Split into N / Send as one**. Each ask gets its own chat (and worktree), and the first one opens. |
| **Needs you** | `/api/shell`'s `needs` (chat needs, goal asks, failing automations). Hidden when empty. |
| **Where you left off** | Threads, 4 shown (10 with "more"). One line each: title · project · state · age — last line. Dots only if the thread has a DoD; `+ done-list (n)` when Minami has suggested one. |
| **Today** | Open to-dos with **Run** (the Today hand-off), then **Go** (sends "go") when the run waits on you, and **Open**. |

**Tiles expand to show their tasks** (`components/home/TopicTasks.tsx`; Thomas: "the bento tile expand to
show task with task UI components — but don't hide other topics for navigation"). Every topic expands
in place when you click it, or its **Tasks n** corner button (**+ Task** when it has none). It takes 3 of 4 columns,
the others stack beside it, and it is full-width on a phone or beside an open panel. Each task is a card:
- state, title, age, number of chats, and its last line
- a done-list bar and dots that tick open (the "use the suggested done-list" chip when Minami has
  proposed one)
- tapping a card opens its chats in the panel, and the expanded tile stays open.

The tile header has **All chats** (the old tile click: the topic's panel), **▶ Preview** and ✕. Its input
starts a **new task**, which is just a new chat in that topic, and is focused when the topic is empty.

> 🐛 2026-10-28 — a topic with no tasks kept the old click (open the chat panel) and its corner button was
> ▶ Preview, so the expanded tile and its "New task" box were unreachable exactly when a first task was
> needed. Now every tile expands; Preview and All chats are in the expanded header.
Opening a topic prefers Thomas's own chats over machine sessions. `/api/threads` now returns up to 60
threads, not 16, so a tile has its own topic's tasks and not only the newest overall.

In a chat, above the composer (`components/home/ChatHints.tsx`):
- **This mentions X. Send there instead.** Enter still sends here.
- **Long chat — name it?** Shown once per chat, after 6 asks, and ✕ never asks again. Naming stores the
  thread and asks Haiku for 2–4 done-criteria, which wait for one tap.

07:30: a push with the top three threads (`lib/morning-push.ts`). Only the live server sends it.

## The board (focus on one project)

**⤢ Board** on an expanded tile (or `/?focus=<project>`) replaces the grid with that project's tasks as a
kanban, `components/home/Board.tsx`. The chat panel still opens beside it. A row of other projects
(those needing him first) switches boards, and ← Topics goes back to the expanded tile. Thomas: "so that
I can focus when I need on a project".

| Column | What puts a card there |
|---|---|
| To do | Added on the board (`queue`): written down, no chat yet. **▶ Start** (or dragging it to Working) starts a chat with its title and joins it. **Drop** deletes it. |
| Working | A chat in the task is running. |
| Needs you | The chat ended on a question or is waiting for review. |
| Paused | Quiet, not finished. |
| Done | Moved here (✓ Done or drag → `archive`, kept 14 days, **Reopen** brings it back). A task with every item met shows **Close** in its own column first. |

Only the two ends are his to move. The middle columns are read from the chats, so a card moves by itself
when a reply lands. Dragging into a middle column shows a note that says so instead of faking a status.
**Narrower than 1060px, the board is one vertical list** (chosen by its own width with a ResizeObserver;
there is no setting). This covers the board beside an open chat, and the phone:
- **Order:** groups in urgency order (Needs you · Working · To do · Paused), then Done folded ("Done 6 ›",
  remembered). Empty groups fold into one muted line.
- **Cards:** the done-list folds to the bar + n/m. A **Minami ✓n** chip appears when Minami ticked items
  since he last opened the card. Tapping it shows the items with reasons.
- **Fixed parts:** "+ Add a task" is pinned at the top, and the bento column scrolls the list (one axis).
- **Removed in this layout:** drag-and-drop (the two ends have buttons) and the sideways carousel.

At any width:
- The project name is the switcher (▾): other projects, those needing him first, plus All chats. It
  replaces a chip strip that was a second sideways scroll.
- The task whose chat is open is ringed, and the focused one scrolls into view.
- A task whose items are all met stays in its column, rises to the top, and shows **Close**. Done holds
  only what was moved there.

Why: measured with a chat open at 1440px, the board column was 442px against 1048px of columns, so
only To do and Working showed. Those are the two usually empty, and using the board meant shrinking the
chat. Thomas: "don't make me reduce chat area". Scenarios and the layout comparison came from a UX agent
pass the same day.

> Working only shows chats hosted by the server you are looking at (`isBusy`), so the `:3001` preview
> shows the `:3000` server's running chats as Needs you or Paused.

## Done-lists and progress

"Progress and DoD is not there" (Thomas, round 4): a done-list that only appeared after naming a thread
was on almost no card. Now (`components/home/TaskCard.tsx`, `ensure` in `app/api/threads`):
- **Every task on screen gets one.** The tile and the board call `ensureDod`. A task with no list gets
  2–4 outcomes from Haiku, written from its first asks and the end of its chat. It shows at once as
  **Minami's done-list** with **Keep** (his "Minami suggests, you tap"), and it already counts as
  progress. A derived task is stored as `auto` to hold it, and ages out after a week like a derived one.
- **Minami ticks what the chat shows is met.** When a task's chat goes quiet with new activity
  (`evalAt` < last activity), Haiku reads the end of the chat (`recentText`, the last 400KB) and returns
  the met items with a short reason. They are ticked with a **Minami** mark and the reason shown under
  the item. His own tick clears the mark and is never undone. Minami may untick only its own.
- **Progress is the segmented bar**: one segment per item, paler green where Minami ticked. The tile
  and board headers add up "n/m done-items met". There are no phases or percentages.
- **Calls:** at most two at a time, one in flight per task, and an empty answer isn't retried for six
  hours. The `busy` ids in GET drive the "writing a done-list…" / "checking…" lines.

## Done closes itself · the checklist in view · Minami, do it

Round 7 (Thomas: "I don't want to check the subtask done manually"; "I click on the progress bar a lot
to … see what I need to do next … indicate which task I am chatting with … better readability for
subtask and button to let Minami do it for me").

- **Done is automatic.** When a task's last done-item is ticked (by Minami reading the chat, or by him),
  the server archives it to Done with `autoDone` (`closeIfDone` in `app/api/threads`).
  - **It fires only on the transition to all-met.** A task reopened by hand, or brought back by a new
    message from him (`revived` in `lib/threads.ts`: a typed message, `lastUserAt`, more than 2 minutes
    after `doneAt`), stays open with Close and doesn't close itself again. A task closed by words
    (`closedWhy` set: said in the chat, `task_report finished`, the close API) never revives; Reopen does.

> 🐛 **2026-10-28 — after a deploy the board showed closed tasks again, open items and all.** He had said
> "this one is done" on several; they came back under Paused with their unticked items. Cause: `revived`
> compared against `lastActivity`, which is `max(last row timestamp, file mtime)`, so any write after the
> close counted as "a new reply" — the chat's own sign-off turn, a CLI metadata row, a pane reattaching
> after the deploy. Measured on `~/.minami/flow.json`: 6 of 6 self-closed tasks were revived, 4–29 minutes
> after closing, and none had a message typed by him after `doneAt`. Fix: `SessionMeta.lastUserAt` (last
> user row with text that isn't a `<…>` harness injection) drives revival, and a close-by-words is final.
> Accumulators cached before the field have no `lastUserTs`; they start from the next message, which only
> errs toward staying done.
  - **The page celebrates it once** (`components/home/Celebrate.tsx`): a burst of confetti and a toast
    "Done — nice." with Open and **Reopen**, because Minami's reading of "done" can be wrong.
  - **Limits:** once per task per browser, only within 15 minutes of closing, and no burst under reduced
    motion.
  - **The archive** is the board's Done column (14 days). The tile header links to it ("✓ n done today").
- **The checklist is in view** (`Dod` in `TaskCard.tsx`):
  - The expanded tile and the wide board show the whole list. The narrow board shows the bar plus the
    **Next** item and "all n items".
  - Items have a round check, full-size text and Minami's reason under its ticks.
  - The first open item is marked **Next**.
- **The task you're chatting with**:
  - **Its card:** ringed, says "● chatting now", and the tile scrolls to it.
  - **The chat:** shows a **Task** strip above the composer with the title, the bar, the Next item and
    Do it. Tapping the strip unfolds the whole list. It's in `ChatHints`, so it shows in every pane whose
    session belongs to a task.
- **▶ Do it**, on the Next item (and on hover/touch for the rest):
  - The `do` action works out where to send: the key that already owns the task's latest chat, else
    `live:<id>` (the alias a panel attaches through).
  - The browser sends "Next on the done-list for …: <item>. Do this now…" through `/api/agent/send`, so
    a chat whose worktree is gone is re-homed as usual, and then opens the chat. Resuming under a second
    key would be two processes writing one transcript.
- **Each Minami tick shows its evidence**: Haiku returns the met items with a reason AND a quote copied
  word for word from the chat, plus who said it. The quote is kept only if it is really in the chat
  (case, whitespace and quote marks ignored). Otherwise the tick keeps just its reason, because a made-up
  quote under a tick is worse than none. The card shows it as an indented italic line ("— you" /
  "— Minami"); tapping it opens the chat. Ticks made before this keep only their reason until the next check.
- **A task can be closed without ticking every item.** He said "I told it is done but it has no way
  to mark itself as done". There are three ways:
  - **Said in the chat.** Every check also asks whether Thomas called the whole task done (or said to
    close it), or the chat declared it finished with nothing left. If so, Haiku returns the exact words.
    They must really be in the chat (the same rule as the quotes on ticks), and the task closes with
    `closedWhy` = those words. The toast quotes them. A task that came back after a new reply doesn't
    re-close on the same old words.
  - **A done task shows no open items** anywhere (`Dod` in `TaskCard.tsx` returns one "✓ Done — “his words”"
    line for an archived task): not on the Done card, not in the chat's Task strip, which used to show the
    Next item and "all n items" under a task he had closed. Reopen brings the list back.
  - **✓ Done by hand:** on every open card (the tile had none) and in the chat's Task strip.
  - **From the chat itself:** `POST /api/threads {"action":"close","key":"$MINAMI_SESSION_KEY"}` (or
    `sessionId`) closes the task holding that chat. Toast: "Closed from the chat".
- **Each item has a status**, so the card shows what is being worked on, not only what's next:
  - **Minami on it** (orange, pulsing): the task's chat is running on this item.
  - **needs you**: the chat stopped and is asking about it.
  - **started**: it was being worked on and the chat is now quiet.
  - **next**: nothing is on, and this is the first open item.
  - **done** ✓.
  - **Which item is on** is the `doing` field on the item. ▶ Do it sets it, and it wins for 10 minutes.
    Otherwise Minami's reading sets it: every check returns `now`, the open item the end of the chat is
    on. While a chat is running, a focus-only check (no ticks) runs at most every 2 minutes per task
    (`focusAt`).
- **Minami's ticks stay.** It reads only the end of a chat, so "not in this reading" can't mean "not
  done". A Minami tick is removed only when the chat says that thing broke or was reverted (`undone`), or
  when he unticks it.

> 🐛 2026-10-28: Minami's ticks fell off as a chat went on. The check reads the last ~7k characters of a
> chat and used to untick any of its own items not confirmed in that window, so a 3/4 task dropped to
> 0/4 an hour later with nothing undone. Ticks are now sticky unless the chat reports the item undone.

> 🐛 2026-10-28: a tick landed a minute or two after the turn that earned it, so he pressed ▶ Do it again
> on an item that was already done. `ensureDod` throttles 60s per `id:at`, and a turn ending
> (working → quiet) keeps the same `at` as its last write, so the full re-read waited out the throttle.
> The key now includes the state, so going quiet triggers the re-read on the next 8s poll.

- The home list's threads call `ensureDod` too, so tasks get done-lists and ticks without the board
  being opened.

## The chat reports its own progress

Round 8 (Thomas: "enhance the semantic tasks and progress — should it be a CLI or something?"). Everything
above is Minami *inferring* progress after the fact: Haiku reads the last ~7k characters of a quiet chat.
That is late, it costs a call per check, and it needed verified quotes to be trusted. The chat doing the
work already knows which item it just finished, so it now says so itself (`lib/task-report.ts`).

- **The tools.** Every dashboard session gets an in-process MCP server, `minami_task` (`taskMcpServer` in
  `lib/agent/manager.ts`), with two tools:
  - `task_status`: the task holding this chat and its numbered done-list, or "not part of an open task".
  - `task_report {done:[{n,why}], now, undone, add, finished}`: tick items with what shows them met, set
    the item on now, untick Minami's own when broken, add missing items, or close the whole task.
  The handler reads `s.sessionId` at call time, so the model never passes a key and a resumed or re-homed
  chat reports for the right task. A line in the system prompt (`TASK_PROMPT`) says when to call them.
- **Why a tool and not a CLI.** A listed tool is called far more reliably than a command the model has to
  remember. It is typed, nothing passes through Bash output, and no key has to be threaded. The
  same logic is reachable over HTTP (`POST /api/threads {"action":"report", key|sessionId, …}`), so a CLI
  for terminal sessions or the Minami bot would be a thin wrapper on it. None is built yet.
- **Same marks as Minami's reading.** A reported tick is `by: "minami"` with the chat's `why` and no quote
  (it's the chat's own word, not evidence pulled from a transcript). His ticks are never touched. `now`
  sets `doing`, which holds for 10 minutes like ▶ Do it. All-met and `finished` close the task through
  the same `closeIfDone` / `closedWhy` path.
- **Haiku is the backup.** A report stores `reportAt`. In `ensure`, a `reportAt` newer than `evalAt`
  skips both the quiet-time reading and the mid-turn focus check, and marks the task checked. A later
  stretch of work the chat doesn't report is then read by Haiku as before. Chats outside the dashboard
  (terminal, Minami bot) don't have the tool and are only ever read.
- `MINAMI_DASHBOARD_TASK_TOOLS=0` turns the tools and the prompt line off.

> 🐛 2026-10-28: ▶ Do it sent "Next on the done-list for "…": <item text>", which had no number in it.
> The chat skipped `task_status`, guessed `n=1` (already met), got back "Recorded: ticked 1." and told
> Thomas the item was done. Item 3 stayed open and the task never closed. Fix, three layers: the
> hand-off says "item N of M" and "tick item N"; `taskReport` refuses to re-tick a met item ("item 1
> was already met — nothing changed") and every reply ends with "still open: …"; `TASK_PROMPT` says
> to tick by the listed number and read the reply. A Minami tick can no longer be re-ticked to change
> its `why`; untick it first if that is ever needed.

## Threads

A thread is derived, not declared (`lib/threads.ts`):
- one session Thomas typed in, plus any continuation ("This session is being continued…") that picked
  it up, joined to his latest session in the same project that was active before it began;
- or a stored thread (`~/.minami/flow.json` v2): a name, its sessions, a DoD, a suggested DoD.

**Machine sessions never count** (`isMachine`):
- the `.minami-bento` scratch dir
- classifier, summarizer and resolver openers
- a Today/Autopilot hand-off he never replied to (fewer than 2 asks).

Opening a thread = its topic's panel with the thread's sessions as the tabs (newest four).

| Piece | Role |
|---|---|
| `lib/threads.ts` | Derivation, the machine filter, the project list. Reads each transcript's head once (start time and first line) and caches it by id. |
| `lib/task-report.ts` | A chat's own progress report: `taskStatus` / `taskReport`, plus the shared `allDone` / `closeIfDone` / `storedFor`. Behind the `minami_task` MCP tools and `action: report`. |
| `lib/flow-store.ts` | The stored part: `~/.minami/flow.json` v2 (`MINAMI_FLOW_FILE`). Read from disk on every call: `:3000` and `:3001` share it. |
| `app/api/threads/route.ts` | GET threads + projects; `?key=` → the session id of a just-started chat. POST: name (with Haiku DoD suggestion via `runHaiku`), dismiss, dod.accept/toggle/add, archive. |
| `lib/use-threads.ts` | One shared poll per tab; `openThread()` (event `minami:open-thread`). |
| `lib/ask.ts` | `guessProject`, `splitAsks`, `startAsk` (isolate → send → wait for the id → `minami:open-chat`). |
| `components/home/Home.tsx` | Ask line, Needs you, Where you left off, Today. |
| `components/home/TopicTasks.tsx`, `TaskCard.tsx`, `Board.tsx`, `Celebrate.tsx` | The expanded tile, the shared task card (done-list always visible), the project board. |
| `lib/morning-push.ts` | The 07:30 digest; `broadcast()` in `lib/push/server.ts`. |

## Decisions

- **No model call on the Ask path.** A project name in the text and a numbered list are both literal.
  A guess that shows itself before sending is corrected with one tap; a model's guess would be slower
  and wrong in ways that are harder to see.
- **A new ask opens by session id, not by pane key.** A pane attaches by id (`attach`); a pane on a
  key with no id showed the topic's "Continuing an earlier chat" instead of the reply. Found in testing.
- **The morning push reads `/api/threads` over loopback.** Importing `lib/threads` from instrumentation
  put the session parser (`node:child_process`) into a graph Next also compiles for the edge, and `/`
  returned 500.
- **Retiring Flow and Agents/Teams** is agreed. The tile's Flow switch is gone; the code goes in a
  separate change.

> 🐛 2026-10-28: an archived thread came straight back. Archived threads stopped claiming their sessions,
> so the next poll derived a new thread from the same chats. They now still claim them, and the chats stay hidden.

> 🐛 2026-10-28: the tile button did nothing on click. A helper named its parameter `project`, which
> shadowed the panel's `project` state, so `project !== p.name` compared the parameter with itself. Renamed.
