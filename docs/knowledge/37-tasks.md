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
show task with task UI components — but don't hide other topics for navigation"). A topic with tasks
(threads) expands in place when you click it, or its **Tasks n** corner button. It takes 3 of 4 columns,
the others stack beside it, and it is full-width on a phone or beside an open panel. Each task is a card:
- state, title, age, number of chats, and its last line
- a done-list bar and dots that tick open (the "use the suggested done-list" chip when Minami has
  proposed one)
- tapping a card opens its chats in the panel, and the expanded tile stays open.

The tile header has **All chats** (the old tile click: the topic's panel), **▶ Preview** and ✕. Its input
starts a **new task**, which is just a new chat in that topic. A topic with no tasks keeps the old click.
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
    reply (`revived` in `lib/threads.ts`: new activity more than 2 minutes after `doneAt`), stays open
    with Close and doesn't close itself again.
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
- The home list's threads call `ensureDod` too, so tasks get done-lists and ticks without the board
  being opened.

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
