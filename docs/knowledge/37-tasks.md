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
"Home" view, with Inbox one tap away; the unfolded Find N5 shows it in two columns, see §23):

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

The tile header has **All chats** (the old tile click: the topic's panel), **▶ Preview** and ✕. Below it,
a **＋ New task** trigger (focused when the topic is empty) opens the **New task sheet**
(`components/home/NewTask.tsx`). A new task is still just a new chat in that topic, via `startAsk`.

**On a phone** (2026-10-28, Thomas: "the experience on phone to start a new task is not there"). The
tile's trigger sat five screens down and one tap behind an expand. A first fix put a ＋ Task pill in
Bento's bottom bar (bfc5f1e); Thomas then picked V3 of the `phone-new-task` pitch, "A tab of its own":
- **＋ Task is the middle tab of the shell's phone nav** (`components/home/PhoneNewTask.tsx`, rendered
  by `AppShell`), so it is there on Today, Autopilot, Ideas and inside a chat, not just Home. More
  keeps its slot (the pitch gave it away): six tabs fit at 393px and More is the only way to Settings.
- **It opens a full screen**, not a sheet (`h-dvh`, which follows the keyboard because the viewport is
  `interactive-widget=resizes-content`). ✕ · NEW TASK · Start on top, the Composer, then the project.
- **The project follows the words**: `guessProject` (the Ask line's), else the shell's project filter,
  else the last-worked thread, shown as "Goes to [chip] — you named it / your project filter / where you
  last worked". A pick from the chip sticks for that draft.
- **One draft key** (`minami:newtask:~phone`), not one per project: the guess can flip while you type.
- Off `/`, nothing listens for `minami:open-chat`, so it goes to `/?open=<sid>` like a notification link.

> 🐛 2026-10-28 — the "Done — nice" toast (`Celebrate.tsx`) sat at a flat `bottom-24`, which on a phone
> is on top of Bento's Home|Inbox bar, and swallowed taps on ＋ Task for its 7 seconds. It now sits at
> `--shell-bottom` + 4.75rem.

**The New task sheet** (2026-10-28, Thomas: "a task description can be long, can have image etc"). The
trigger used to be a one-line `<input>`, which could hold "fix the favicon" but not a real brief.
- The editor is the chat `Composer` itself (`roomy`, `sendOnMod`, `maxHeight` props), so paste, drop and 📎
  photo produce the same path-in-the-text a pane sends. `/api/agent/send` inlines the images for Claude.
- **⌘↵ starts it. Enter adds a new line** and continues lists. With Enter-sends, the first paragraph break
  would start a half-written brief.
- Attached images show as removable thumbnails. The path pattern is `lib/image-refs.ts`, shared with the
  transcript's `ImageRefs`, and must stay in step with `IMAGE_PATH` in `lib/agent/images.ts`.
- The draft is kept per project in `localStorage` (`minami:newtask:<project>`). When a draft is left
  behind, the trigger reads **Draft · first line… continue ›**.
- **Start closes the sheet at once and the start runs in the background** (`startInBackground` in
  `lib/ask.ts`, both the desk sheet and the phone tab). The draft is cleared on click and put back by
  `onFail` if the start never got going (unless a newer draft has been begun). Progress shows in the
  shell's **Starting chip** (`components/shell/Starting.tsx`, every page): spinner → **Task started ·
  Open** (auto-hides after 15s) or **Couldn't start — draft kept**. It never opens the chat by itself.

> 🐛 2026-10-29 — Start task froze the board. The sheet awaited `startAsk` with its backdrop up: the
> worktree, the send, then up to ~20s polling `/api/threads?key=` for the session id. Nothing behind it
> was clickable until then, and the phone version finished by jumping to the board. The store lives at
> module level in `lib/ask.ts` so a start survives the tile collapsing or a client-side page change.
- The sheet is portalled to `<body>`. The tile sits in a reflowing grid, and a `fixed` element under a
  transformed ancestor is placed against that ancestor, not the viewport.
- Not covered: the board's **+ Add a task** still queues a title only. A queued task has no body to keep.

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
  - **Only on a quiet chat.** All-met while the chat is working or ends on a question to him sets
    `closeHeld` instead; the next evaluate of an idle chat closes it. The chat's own `task_report` ticks
    always hold (it reports from inside its turn). His own tick and his words still close at once.

> 🐛 **2026-10-29 — "why this one marked done even though it still asking me questions".** The phone-tasks
> chat ticked its last item via `task_report`, the task closed on that tick, and the same turn then asked
> him "Ship it?". Cause: `closeIfDone` ran on the tick with no look at the chat. Fix: the hold above. The
> phone dock chip also printed "done" for any read, quiet chat (the session group `idle`) — it now shows
> the task's state (needs you / working) and nothing for idle.

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

## How a task runs: auto, your pick, asks you

Round 9 (Thomas: "some task can automatically go through all to-do in one go without my click on to-do,
but some task need my confirmation … UI UX, I usually ask for pitches … make it rare for me to actually
need input"). `lib/task-pace.ts`, pure, so the card, `task_status` and the server read one plan.

- **Every done-item has a gate** (`FlowDod.gate`):
  - `null` (auto): the chat does it and moves on. This is most items.
  - `"pitch"` (**✋ your pick**): it decides how something looks or how a person uses it. The chat
    pitches versions and asks him to pick.
  - `"ok"` (**✋ asks you**): it leaves the machine or can't be undone (publish, post, send, spend,
    delete, a customer-facing prod push). Local commits, merges and deploys of his own tools are auto.
  - Haiku sets the gate when it writes the list (`suggest` returns `{t, gate, why}`, and UI work gets a
    first item for his pick). Items added later are labelled by `classify` in `ensure`. **When unsure,
    auto.** His tap on the chip cycles auto → your pick → asks you, sets `gateBy: "thomas"` and is never
    re-guessed. Ticks keep the gate (`gateOf`).
- **A run** is every open item up to the first gate (`runPlan`):
  - **The card** says it in one line ("Runs A→Z on its own" / "Runs 2 on its own, then your pick" /
    "Waits on your pick first") and has **▶ Run n**, which sends the whole stretch in one message
    (`action: "run"`). ▶ Do it on a single item is unchanged.
  - **`task_status`** ends with a "How to run it" line naming the gated items, and `TASK_PROMPT` tells
    every chat to follow it. So a chat started from a typed prompt also runs straight through.
- **Auto-continue** (`maybeContinue` in `/api/threads`) is the net for a chat that stops early anyway.
  When the task is idle and its next open item is labelled auto, the server sends the run message to
  the chat, prefixed "(Minami, auto-continue)". Every one of these guards is needed:
  - Only the process hosting the chat sends it (`sessionIdentity`). The `:3001` preview never drives a
    `:3000` chat.
  - The first nudge needs a `task_report` after his last message (the chat is working the list). Every
    later nudge needs a newly met item since the one before. A chat that answers with no progress is
    left alone; seen in testing, it explained the blocker and stopped.
  - At most 6 nudges since he last typed. A message of his more than 30 s after a nudge resets the
    count.
  - It waits 8 s after the turn ends, then decides again from disk.
  - `MINAMI_TASK_AUTORUN=0` turns it off.
  - It runs on `ensure`, so it needs a page that polls (the tile, the board, Home or a chat's Task
    strip) to be open somewhere.
- **Only a gate flags him.** A quiet task whose next open item is gated derives as `waiting`
  (`lib/threads.ts`). That puts it in the board's Needs you column with the sakura tint, and the item
  shows "needs you". An auto item never flags, because auto-continue moves it.

> 🐛 2026-10-28 (found in testing): an item still waiting for its label ran as auto, so a "page layout
> chosen" item was nudged on seconds before Haiku labelled it `pitch`. Auto-continue now waits for the
> label. ▶ Run, which he presses himself, still treats an unlabelled item as auto.

Tested end to end on an isolated server (`:3027`, `MINAMI_FLOW_FILE` in `/tmp`):
- A 3-item task whose chat was told to stop after item 1 was nudged once, did items 2–3 and closed
  itself.
- With item 2 labelled `pitch`, there was no nudge and the task read `waiting`.
- Haiku labelled "layout chosen" / "API returns values" / "tests pass" / "post published on X" as
  pitch / auto / auto / ok.

## What it waits on you for (the step)

Thomas, 2026-10-29, on a tile whose chat had just asked "Should I merge and deploy it?" while the card's
"next" pointed at "Tile layout holds at phone and desktop widths": "task like this need better next step,
like merge or deploy … rather than irrelevant next to do list / subtask that make me have to read and
check where is the task". The done-list says what *done* looks like; it never said what the chat is
stopped on, and the chat's own `task_report` skips `evaluate`, so nothing read the end of the reply.

- **`readStep`** (`app/api/threads`): once per quiet (`stepAt` < `v.at`, stored tasks only, any state but
  working), Haiku reads the end of the latest chat and returns either `null` or a `TaskStep`
  `{q, yes, reply, ship}`: the question the reply ended on, or the finished-but-unshipped step (committed
  not merged, merged not deployed, drafted not published). Runs even when the chat reported for itself.
- **It shows only while current**: `threads()` passes `step` through when `step.at >= lastActivity`, so
  any newer turn hides it until the next reading. A current step makes the task `waiting` (Needs you, and
  `closeIfDone` holds, so a task doesn't close itself with its merge still asked about).
- **The card leads with it** (`Dod` in `TaskCard.tsx`, so the tile, the board and the chat's Task strip):
  "✋ Merge and deploy the tile layout fix?" with **▶ Merge & deploy** (sends `reply`, "Yes, merge and
  deploy it.", through `action: "answer"` + `/api/agent/send`, routed like ▶ Do it) and **Reply** (opens
  the chat). Meanwhile no item is marked "next", and the pace line and ▶ Run are hidden. Home's "Where you
  left off" row and the phone task row show the question in place of the tail / next item.
- **Answering clears it at once**, so a second tap gets "nothing is waiting on you here".
- **Ship steps on the list**: a `ship` step with no item matching merge/deploy/live/ship/publish adds
  "Merged and deployed" (gate null; GATE_RULES already treat merging/deploying his own tools as auto).
  `suggest` now ends a code task's list with that outcome too: work sitting on a branch isn't done.
- **`recentText` keeps the end of a long message** (first 600 + last 900 chars). It kept the first 1500,
  which cut off exactly the closing question, for `evaluate` as well.

Tested on an isolated `:3027` server with a copy of `flow.json`: the screenshot's task came back
`{q: "Merge and deploy the tile layout fix?", yes: "Merge & deploy", reply: "Yes, merge and deploy it.",
ship: true}`, state `waiting`, and gained "Merged and deployed"; `answer` returned the owner key and
message, and a second `answer` was refused.

## What the logs showed (2026-10-29)

A sweep of `~/.minami/flow.json` (58 tasks), 293 transcripts from four days, and the deploy, event and
launchd logs. Fixed in the same change:

> 🐛 **One chat, two tasks.** 3 chats were claimed by two stored records each, so each showed twice, with
> two done-lists. The live case was this sweep's own chat: its list changed between two `task_status`
> calls. Cause: `suggest`, a chat's first `task_report`, `close` and the derived-id edits each stored a
> derived task (`s:…`) with a fresh id, matching only on that id, and they raced. Fix: `storedFor` also
> matches by session and every path uses it. In `threads()` the first claim wins: a named task beats one
> Minami stored, an open one beats a closed one, and then the newest wins. Old duplicates stop showing.

> 🐛 **Auto-continue nudged a chat that was waiting on its own agents.** The turn had ended with three
> background readers still out. The chat read as `idle`, and its opening `task_report {add, now}` counted
> as "working the list". Fix: `awaitingAgents(key)` (agents only, like the deploy veto) makes the thread
> `working`, and `maybeContinue` skips it. The first nudge now needs an item **ticked** after his last
> message, not just any report.

> 🐛 **A chat asking him a question sat in Working.** An AskUserQuestion (or a plan to review) parks
> the turn *inside* the tool call, so the manager's `busy` stays true the whole time it waits. `threads()`
> read busy as `working` and gated `waiting` on `!busy`, so the task never reached Needs you and the
> card's line was the stale activity; he only found the question by opening the chat. Fix:
> `awaitingHuman(key)` in `lib/agent/manager.ts` returns the parked `Need`; a thread with one is
> `waiting`, its line is the question, and `ask` is set. The route treats `ask` as mid-turn (`mid`), so
> the quiet-chat readers (step, evaluate) don't read a half-finished reply as the task's end.

> 🐛 **Closed tasks kept an item "on now".** No close path cleared `doing`: 4 archived tasks had one, and
> 3 open ones were 13–17h stale. `closeTask()` in `lib/task-report.ts` is now the only way to close a task.
> It clears `doing` and `dodPending`. Of 58 lists, 52 were still "suggested": the Keep tap is almost never
> made, and nothing else cleared the flag.

> 🐛 **Machine prompts as tasks.** "You are resolving a git merge conflict…" (×3), "You are in a git
> worktree…", "Minami · Slack turn" and pace-test pings were on the board. Added to `MACHINE`.

Two concept changes Thomas picked from the findings the same day:

- **Today work is task work** (`linkTasks` in `lib/today.ts`, run by `reconcile`). Only 2 of 78 Today
  hand-off sessions belonged to a task, and 26 of 32 hand-offs in four days never called the task tools.
  A hand-off he never typed in is machine to `isMachine`, and Today kept a second done-list system
  (`done_when`). Now every `do`/`decide` hand-off from the last 3 days that is still open is stored as a
  task holding its chat, linked by `today: {date, kind, id}`. A stored claim bypasses the machine filter.
  - **The done-list** is its `done_when` checks in words ("blog live at …", "committed in …"). Without
    them, Haiku writes one as for any task.
  - **Each side closes the other.** A ticked to-do closes the task, with the to-do's evidence as
    `closedWhy`. A closed task ticks the to-do (`done_by: "minami"`), which is what frees its dependents
    in the Today runner. A to-do he set by hand (`manual`) is never ticked by this. A task he reopened
    (`reopenedAt`) is closed again only by a newer tick.
  - **Not linked:** `ask` hand-offs (only a Slack card), and to-dos already done when this shipped, which
    would have buried his own tasks in Done.
- **No more Keep.** 52 of 58 suggested lists were never kept, and 136 of 137 ticks were Minami's, so the
  tap decided nothing. Minami's list is now just the list: edit it, untick it, add to it. `dodPending`
  is no longer set or shown. `dod.accept` stays as a no-op for old tabs.

Found and left open:
- **Auto-continue rarely fires**: twice in the whole store. The run rules in `task_status` do the work.
- **`task_status` outside a task**: 15 replies of "not part of an open task", from chats the prompt told
  to check. The reply now tells the chat not to call it again in that chat.

## On the phone: the sheets list tasks

Thomas, 2026-10-29, on the phone's all-chats sheet: "clunky, I want to view task instead of sessions. it
requires me to navigate too much to get where I want." The sheet listed sessions (worktree-grouped, §23),
so machine chats like "Pace test: ok" sat between his tasks, and a task's done-list existed only on the
desktop tile and board.

`components/PhoneTasks.tsx`, mounted by both phone sheets in `components/Focus.tsx`:
- **☰ sheet** opens on **Tasks**: Needs you · Working · Recent (12, then "n more"), topic chips that
  only show topics with an open task. Each row has the done-list bar and the next open item, readable
  without a tap. **Tapping the row opens the task's latest chat** (`openChat(t.latest)`, not
  `openThread`, so the phone keeps its one-chat-at-a-time pane). "n chats ▾" lists the others.
- **Current-chip sheet** (one topic) has the same Tasks | Chats switch; a topic with no open task opens
  on Chats.
- **Chats** is the old list unchanged, a tab away: pins, Edit pins, the Today fold, Older. Machine chats
  aren't threads (lib/threads.ts drops them), so this is where they stay reachable.
- The **dock chip** names the task the open chat belongs to, with its `met/total`.
- Queued tasks (board To do) are left out: they have no chat to open yet.

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
| `lib/ask.ts` | `guessProject`, `splitAsks`, `startAsk` (isolate → send → wait for the id → `minami:open-chat`), `startInBackground` + the starting store. |
| `components/shell/Starting.tsx` | The shell's chip for background task starts: spinner, Open, or the error. |
| `components/home/Home.tsx` | Ask line, Needs you, Where you left off, Today. |
| `components/home/TopicTasks.tsx`, `TaskCard.tsx`, `Board.tsx`, `Celebrate.tsx` | The expanded tile, the shared task card (done-list always visible), the project board. |
| `components/home/NewTask.tsx`, `lib/image-refs.ts` | The New task sheet (long brief, images, saved draft); image-path parsing shared with the transcript. |
| `components/home/PhoneNewTask.tsx` | The phone's ＋ Task tab and its full-screen composer (project guessed from the text). |
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

> 🐛 2026-10-29 — "several tasks sharing the same subtask content and sessions". One chat showed as two
> or three cards, each with its own done-list. Cause: a derived task's id is `s:<session>` and its stored
> record gets a fresh `fid()`, but `suggest`, `storedFor` (the chat's `task_report`) and the edit actions
> looked the record up by `v.id` alone. Each missed the record another had just made and added its own.
> Haiku's ~10s done-list call overlapping a `task_report`, or `:3000` and `:3001` both polling, was enough.
> `flow.json` had 3 chats claimed 2–3 times. Fix: `findStored` (`lib/flow-store.ts`) finds a derived
> view's record by the chats it holds, and every lookup goes through it. `readFlow` gives each chat one
> owner: the record with the most met items wins, then the oldest, and a record left with no chats is dropped.

> 🐛 2026-10-28: an archived thread came straight back. Archived threads stopped claiming their sessions,
> so the next poll derived a new thread from the same chats. They now still claim them, and the chats stay hidden.

> 🐛 2026-10-28: the tile button did nothing on click. A helper named its parameter `project`, which
> shadowed the panel's `project` state, so `project !== p.name` compared the parameter with itself. Renamed.

> 🐛 2026-10-28: a long task card only opened from its title block, so with the done-list unfolded he
> had to scroll back up to click it. The whole card now opens the task (`onCard` in `TaskCard.tsx`); clicks
> on its own controls and text selections are skipped.

> 🐛 2026-10-29: **"Everything is waiting for each other."** Five tasks read Waiting. Three were already
> merged and live: autopilot or another chat had merged their branch, but `readStep` and `evaluate` read
> only the end of the task's own chat, so a merge done elsewhere never reached the task, and the tile card
> kept asking "Merge and deploy the tile layout fix?". All four "Merged and deployed" items also sat on
> "your pick", from one tap each on the gate chip (`gateBy: thomas`). A gated item makes the task Waiting
> and tells its chat to stop there, so even a chat that had seen the merge didn't tick it. The fourth task
> was really blocked: an uncommitted 18-line doc edit in the main checkout made `task.mjs merge` refuse
> every merge. Fixes:
> - `shippedLive(cwd)` in `lib/task-ship.ts`, run by `tickShipped` in `ensure`: a task worktree that is
>   clean, has commits past where its branch was cut (the branch reflog's first entry), is an ancestor of
>   main, and is older than `.next/BUILD_ID` ticks its open ship items and drops a `ship` step. Only
>   `.minami-worktrees/*` trees in this repo, since only here can "live" be checked; cached a minute per tree.
> - Ship items (`SHIP_ITEM`, now in `lib/task-pace.ts`) can't hold "pitch": `gateFor` drops it at all three
>   gate sites (suggest, classify, the chip's `gate` action), the chip cycles auto → asks you → auto for
>   them (`nextGate(g, ship)`), and `GATE_RULES` says so. Thomas: merges run on their own.

