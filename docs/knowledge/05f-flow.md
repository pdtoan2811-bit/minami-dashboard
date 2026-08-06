# Flow — the session journey, its brake, its queue

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 5f. Flow — `components/FlowCanvas.tsx`, `components/FlowStrip.tsx`, `lib/flow-model.ts`, `lib/flow-narrate.ts`

**One spine per session, one node per thing you asked for, and each node says what was wanted and how
it turned out.** It answers three questions the transcript cannot: what have I asked this session for,
did each of those actually land, and what did I start and never close.

### v4 — the unit is the ask, and the content is meaning

v3 drew one **turn** at a time, as a spine of plan steps with every tool call hanging off it as its own
node. Two things were wrong, and they were the same thing twice:

1. **A turn is not a journey.** You could read one turn perfectly and still have no idea whether the
   thing you asked for four turns ago ever finished. The pager (`‹ turn 7/23 ›`) made *"where am I on
   the way to what I wanted"* impossible to even ask.
2. **Tool calls are not steps.** `Read · Read · Grep · Bash · Edit · Bash` is a log, not an account of
   the work — maximally detailed, minimally informative. You had to re-derive the meaning yourself,
   which is the labour the view existed to save.
   *Reported by user: "Tool use log is too much detailed and noise, which is awful. I want the semantic
   intuitive idea of goals of each step and how AI handled it."*

So the canvas is now **one spine for the whole session**. Tool calls still exist — two clicks deep, as
evidence, which is the only time anyone wants them.

**Three columns, three levels of disclosure:**

| Column | Unit | Says |
|---|---|---|
| spine | one **ask** | what you wanted · verdict · goals done · duration · cost · files · checks |
| fan right | one **phase or plan goal** | what it was for · what it did · the files and commands as evidence |
| fan right again | one **tool call** | the raw log — v3's entire default view, demoted |

Settled milestones collapse to one dense line; the live one (or, on a settled session, the newest) is
open. Past work stays *reachable* rather than windowed away — that is the part a "last N turns" view
would get wrong.

### The semantic layer is rules, and that is deliberate

`lib/flow-model.ts` maps every tool into one of nine **acts** — `changed · verified · delegated · ran ·
browsed · asked · searched · read · other` — and phrases each group in the past tense, about the work
rather than the tool ("changed 3 files", never "3 Edit calls"). Acts are ordered by how much they tell
a reviewer, not by when they happened: a step that read forty files and changed one is, to the person
reviewing it, a step that changed one file.

It has to be rules, not a model: it must be right while a turn is still streaming, it must work with
the network down, and it must never invent a fact.

**Evidence is separated from claims.** A `Check` is a command whose result is a *verdict* — a build, a
test, a commit, a deploy — matched against the whole command string, not just its head, because the
verdict-bearing part is usually downstream of a `cd`/`&&`/pipe. "It says it built" and "here is the
exit code of the build" are different claims, and only the second one settles an argument.

### The narration is additive, never a replacement

`lib/flow-narrate.ts` spawns `MINAMI_CHEAP_MODEL` (Haiku) to write the sentence rules cannot: *"rewired
the deploy gate to refuse a busy pane; timeout left unwired"*. Three rules, in order of how much
trouble breaking them causes:

1. **It never replaces the rules.** A narrative is an *additional* field on a milestone that already
   has a true `headline`. Narration off, model unreachable, JSON malformed, box offline — every one of
   those degrades to a view that still says something correct.
2. **It only narrates FINISHED milestones.** A running turn's outcome is not yet a fact, and paying for
   a guess produces a sentence that stays wrong for as long as the turn lasts — the worst failure for a
   view whose job is *"can I trust that this is done"*.
3. **It is cached against content, not just identity.** A milestone that grows gets a new signature and
   is re-narrated once; an unchanged one is never paid for twice, however many panes open the flow.

One call per **batch** of up to 8 milestones (`MINAMI_FLOW_NARRATE_BATCH`), deduped per session by an
in-flight map, cached to `~/.minami-bento/flow-narratives.json`, and spawned with `cwd` set to that
same dir — `ENRICH_MARKER` hides sessions born there, and narrating from anywhere else would put a new
tile on the very grid you are looking at. `MINAMI_FLOW_NARRATE=0` turns it off; the header then says
**rules only** rather than silently getting worse.

`/api/flow/[id]` returns **narratives only, never the journey**. The canvas already fetches
`/api/bento/session/<id>` and folds it, and that fold carries every tool input and output (including
base64 screenshots) — returning a second folded copy would double the page's heaviest fetch to deliver
a few hundred bytes of prose. `GET` is cached-only and free; `POST` narrates. The keys line up because
a milestone is keyed on the **byte offset** of the row that opened it, which is immutable in an
append-only transcript, so the server folding its own copy and the browser folding its page arrive at
the same keys without either telling the other anything.

### What counts as an "ask" — measured, not imagined

A user row is not just what you typed: hooks, slash-command wrappers, system reminders, pasted
screenshots, skills the model loads for itself and the CLI's own resume/compaction preambles all arrive
on the same channel. `cleanAsk()` strips them, and **returning `""` is load-bearing** — an ask-less row
folds into the milestone above it, keeping the work attached to the ask that caused it.

Measured by folding **386 real transcripts on this box**:

| Pattern | Why it isn't an ask |
|---|---|
| `[Image: original 2910x1586…]` | a pasted screenshot's marker; part of the ask above it |
| `Base directory for this skill: …` | a skill the *model* loaded, injected as a user row |
| `Continue from where you left off.` | auto-resume |
| `This session is being continued from…` | post-compaction preamble |
| `<task-notification>` | a background task reporting in |
| `go` · `continue` · `yes` · `try again` | an acknowledgement, not a new intent (`isAck`) |

On one 439-turn session that is the difference between **nine** milestones — three of them titled
`[Image: …]` or the body of a skill — and **five**, each an actual sentence the human typed with the
work that answered it attached. Across 60 sessions it removed 204 of 1,128 phantom milestones.

`isAck` is exact-match and deliberately short. Anything with a noun in it is a real ask however brief
("push to main", "deploy") and keeps its own node: the rule is *"this message adds no new intent"*, not
*"this message is short"*.

### The progress meter counts what exists

Counting plan items is the better answer, but **most sessions never write a plan** — measured, a real
439-turn working session in this repo made zero `TodoWrite` and zero `TaskCreate` calls, so a
goals-only meter would have read `0/0` for the entire thing. Where no plan items exist anywhere,
`progress.unit` falls back to `"asks"` and the UI renders the word, so the number never quietly changes
meaning. `open` stays a count of unfinished **plan** items in both units: an ask that ended in a
question is not an open loop, it is your turn, and conflating the two would put an amber warning on
every conversation that ever asked you something.

**Open loops are the point of the rework.** A milestone that is no longer the live one but still has
plan items unfinished is drawn amber, listed in the header, and expandable in one click. That is
"losing the thread" made visible.

### Cost and duration

`Turn.cost` (§1) is priced per assistant message from the row's own `usage`, so a step can say what it
cost without a second pass. A turn is charged to exactly one step, so summing step costs across a
milestone cannot double-count — but `t0`/`t1` are a **span**, and spans of a revisited step legitimately
overlap, which is why a milestone's own totals come from its source rows rather than from its steps.
Sub-cent costs and a `0` from a transcript parsed before the field existed both render as nothing:
unknown is not free.

### Three earlier revisions, and what each one actually got wrong

**v3 is where the graph landed, and v4 kept all of it** — the placement, the expand-into-the-canvas
motion, the no-minimap decision and the two doors are unchanged. What v4 replaced is what the spine is
*made of*, not where it lives.

**v3 is what was asked for from the start:** the graph lives in the **bento column**, and a
`flow` switch on a tile **expands that tile into the canvas** — no overlay, no separate route; the tile
*becomes* the screen. The motion is free: the tile wrapper already carries framer's `layout`, so the
change animates.

**v3.1 — the flow screen is a screen, not a big tile.** Originally the expanded tile took a full row and
three rows of height and every *other* tile reflowed around it. That read as "one tile got bigger": the
rest of the grid stayed on screen competing for attention with the graph you opened in order to read, and
the canvas got three fixed rows with dead space below. Now, while `flowFor` is set, the grid renders
**only** the flowing project — the other project tiles, Autopilot and "New topic" all return `null` — and
the grid itself becomes a single full-height cell (`h-full grid-cols-1 grid-rows-1`) so the canvas gets
the whole column. The header stays: search, window and sort are still the way you get around.

That has one consequence worth stating, because it is the kind of thing that turns into a trapped user:
**the canvas's own ✕ is now the only control on the screen.** So there are deliberately two more ways
out — **Escape** closes it, and if the still-visible search box filters the flowing project out of
`projects`, the flow closes itself rather than leaving an empty screen with nothing clickable on it.

React Flow is back, and here it is the right tool — this genuinely is a canvas now, with room to pan a
wide plan. What went is the part actually complained about: the **minimap**, and the zoom controls with
it. `fitView` re-frames on every plan change, which is what a minimap stands in for, with a `minZoom`
floor so a ten-step spine stops shrinking before the labels go unreadable and you pan instead.

Two doors, one destination: the switch on the tile, and the plan strip in the chat
(`components/FlowStrip.tsx`) — which raises the same expanded tile and un-rails the bento first, since
otherwise the click appears to do nothing. There is no second flow surface to keep in sync.

The canvas fetches its own transcript over HTTP rather than reading a pane's live SSE state: it sits in
page scope, panes each own their `useAgent`, and two subscribers to one session is two copies of the
truth. It folds the JSONL with the same `buildFlow` the chat uses, so the two cannot disagree about what
ran — at most one poll behind. It defaults to the newest turn that *has* steps rather than blindly the
last one, because a request that hasn't called a tool yet would otherwise render an empty canvas.

The brake moved to the composer's control row, next to Plan/Code and the approval level, where it always
belonged — it is a session control, not a property of a view.

> 🐛 **v4: three bugs, all of them "state that fought itself".** Found by driving the real app, not by
> reading the diff — each one type-checked and built cleanly.
> **(1) The canvas opened collapsed and would not stay open.** `open` was reset inside the poll effect,
> which depends on `busy` — and `busy` flaps between tool calls on a live session, so every few seconds
> the reader's expanded nodes were silently collapsed while a seed effect raced to reopen them. Reset is
> about *identity*, not activity, so it moved to its own effect keyed on `sessionId` alone. The seed
> effect went too: the default open node is now **derived** (`open ?? {newest}`, with `null` meaning
> "the reader hasn't chosen yet"), and a derived default cannot race because there is no write to lose.
> **(2) A running session drew its newest ask as `done`.** The exact bug v3's own post-mortem records,
> reached by a new road: the on-disk transcript carries no `streaming` flag — that exists only on the
> live SSE stream — so a caller reading the JSONL has no way to know a turn is in flight. `buildJourney`
> now takes `{ busy }` explicitly rather than inferring it. **The lesson repeats: any derivation over
> the JSONL that wants liveness must be told, never left to guess.**
> **(3) Merged continuations duplicated their phases.** A milestone is often several folded turns, and
> each fold names its synthesized groups `t<foldIndex>-<act>` — so concatenating gave one milestone two
> "read the code" nodes and two "ran the commands", making it look like the model had done the same
> thing twice. `mergeSteps` keys synthetic steps on the **act**, not the fold, and plan steps on their
> real key (never merged across keys — `reconcileKeys`/`TaskCreate` already established that identity).
> The same pass fixed the milestone's time span, which was computed incrementally against the *first*
> fold's `t0` and under-reported a 26-minute milestone as 20.
>
> Also fixed here, unrelated to the rework but in the same files: the milestone node mixed `border` and
> `borderLeft`, which React warns about on every re-render ("can lead to styling bugs") — and a node
> whose tint changes as a milestone settles re-renders constantly. Longhand now.

> 🐛 **The module graph claimed the canvas armed the brake. It hasn't since v3.** `c/FlowCanvas →
> r/hold` was carried over from the v1 panel, which owned the pane's live state; the brake actually
> moved to the composer's control row and is armed from `lib/use-agent.ts`. Nothing failed — a wrong
> edge just gets *drawn*, confidently, on `/architecture`. This is the failure mode the `minami-kb`
> procedure's "re-run the extraction script rather than editing from memory" step exists to catch, and
> it was found by running that script.

> 🐛 **Self-audit of v3: two features that could never fire.** v3's canvas was assembled by lifting
> v1's node-layout code wholesale — and v1 had the pane's live SSE state, while this component reads the
> transcript from disk. Two things came across that cannot work here, and neither failed loudly:
> **(1)** the held-for-review rendering — `heldKey` was passed as a hardcoded `null` and `heldStepKey()`
> was never called, so five branches, a constant and an icon import were unreachable code implying a
> feature that wasn't there. Deleted, with a note where it used to be. **(2)** `busy` was derived from
> `turns[last].streaming`, but `streaming` is set only on the live stream — the on-disk transcript never
> carries it, so the running-step edge animation was pinned off. It now comes from the page, which
> already polls `/api/agent/live` keyed by session id.
> Three smaller ones from the same pass: the canvas re-read a *finished* session's JSONL every 3s for a
> guaranteed-identical answer (now 20s when idle); the strip could hand it an empty session id for a
> pane that hadn't gone live yet, fetching `/api/bento/session/` and rendering what looks like a broken
> canvas (now prefers the live id and refuses empty); and `fitView` with a zoom floor landed wherever
> the clamp left it, so it now frames the running step when the graph can't fit whole.
>
> The process lesson is the useful part: **splicing a component out of another component's source
> carries its assumptions across silently.** Both dead features type-checked, built, and rendered — the
> only way they surfaced was reading the assembled file back and asking what each prop was actually
> connected to. *Prompted by user: "audit them again and revise yourself to see if you slopped".*

### v1 was wrong about the noun, and everything else followed

v1 was a React Flow canvas behind a per-project **view mode**, picked from a hover-revealed ⚙ on a bento
tile and persisted server-side. Three complaints came back — the button was unfindable, the steps were
"an awful long list", and it needed the bento's expand-and-push motion — and all three were the same
mistake:

- **A flow is a property of a TURN, not a project.** Asking "is this a flow project?" from the grid,
  before opening anything, is a question nobody has. The control wasn't hard to find because it was
  small; it was hard to find because nobody goes looking there. It now opens from the plan strip in the
  chat — the thing the flow is *about*, at the moment you're curious.
- **It replaced the transcript.** Flow-or-chat is a false choice; the answer to "what did it just do"
  usually needs both. The panel now expands in place above the composer and the transcript stays.
- **A canvas cannot do the interaction that was wanted.** "Expand a step and push the others away" is
  layout, and React Flow nodes are absolutely positioned — v1's own comment admitted it had to fan
  children to the RIGHT because a parent's height "would push the whole spine apart". In DOM the push is
  free (measured: opening a group displaces its siblings by 226px), grouping is markup rather than a
  layout algorithm, and the minimap/zoom question disappears with the canvas. A minimap is for exploring
  an unknown topology; a plan is a list, and it has none.

**Grouping is by status, and that is the whole readability fix.** Twelve equal rows is a wall. Grouped
into `running` (open) · `up next` · `done` (both one line), a twelve-step plan is three lines plus the
thing you actually came to see — which is the reviewer's real question. Inside a step the tool calls are
grouped by what they DID — changed · ran · read — rather than by tool name, for the same reason.

> 🐛 **The flow existed; the door didn't.** The strip that opens it read raw `TodoWrite` input, while
> the panel behind it called `buildFlow` — two derivations of the same thing, and the shallower one
> decided whether there was any way in. `lib/flow-model.ts` deliberately understands three plan tools
> (Claude reaches for `TaskCreate` on its own) and synthesizes steps from tool calls when there is no
> plan at all — so a `TaskCreate`-tracked turn, and every unplanned turn, built a perfectly good flow
> with nothing to click. Exactly v1's failure wearing new clothes: the feature was there and could not
> be reached. Both now read one folded turn lifted into the pane, and the strip stays put during a live
> turn so the control is somewhere the eye can learn. Verified across four turn shapes — TodoWrite,
> TaskCreate, no-plan, and running-with-nothing-yet — all four get a door.
> *Reported by user: "how to find it?"*

### It is a disclosure, not a route
The panel is component state inside `ChatColumn`, so it dies with the pane and there is no stored "which
view is this project in" to drift out of sync with anything. `lib/view-prefs.ts` and `/api/bento/view`
were deleted with the mode they served. Session menu, Composer, Plan/Code, the approval pills and the
browser panel are untouched and shared by construction — a separate `/flow` route would mean a second
copy of the send / steer / stop wiring, and therefore a second place for the permission model to be
subtly wrong.

### The brake is `canUseTool`, and that is the only place it could be
`setHold()` flips `s.hold`; the gate then refuses to auto-approve and parks the call, reusing the
permission machinery that already existed (`{t:"permission"}`, `phase=awaiting`, `decide()`).

**Steering is a denial with a reason.** `decide(key, id, "deny", note)` hands the note back as the tool
result, so a correction typed against a held step is read and acted on *inside the same turn*, with the
turn's context intact — not as a follow-up after the bad step already ran. Verified end to end: held
`touch gate-test.txt` → steered → Claude re-issued `touch steered.txt` in the same turn, and
`gate-test.txt` was never created.

Releasing the brake does **not** retroactively approve what is already parked. "Resume the session" and
"run this specific step" are different decisions.

> 🐛 **The brake did nothing, because the gate was never called.** First end-to-end test: hold armed,
> the pane showing "release", and three `Bash` calls ran straight through. Cause was already written
> down in this repo — *"a session born in bypass never calls it at all"* (the comment inside
> `canUseTool`). Handing the SDK `permissionMode: "bypassPermissions"` at spawn makes the CLI resolve
> every tool itself; our hook is dead code for that session's entire life.
>
> Fix: `spawnMode()` — tell the SDK `default` (the most restrictive mode, so it asks about everything)
> and let `canUseTool` apply the real mode from `s.mode`. `plan` is passed through untouched, because
> it changes model *behaviour*, not just permissions. This widens nothing, and it also repairs a
> pre-existing bug nobody had connected: the composer's approval pills could never tighten a running
> bypass session either, for exactly the same reason.

> ⚠ **A parked call pins `busy` true, and `busy` is what `bin/deploy.sh` waits on box-wide.** So an
> unattended hold starves every deploy on the machine — the deadlock the `minami-flow` skill documents,
> reached by a new road. Hence `HOLD_TIMEOUT_MS` (10 min, `MINAMI_HOLD_TIMEOUT_MS`), shown as a live
> countdown in the drawer. It expires to **deny**, never allow: "the human never looked" is not
> approval, and denying keeps the session alive where an abort would throw the turn away.

### Node identity, and the two plan tools
`lib/flow-model.ts` is a pure derivation over the same `source` array the transcript renders (the same
shape of thing as `browser-view.ts`) — so the two views cannot show different runs. **Both** plan tools
are read, because both are live:

| tool | semantics | identity |
|---|---|---|
| `TaskCreate` / `TaskUpdate` | incremental | real id, parsed from the result text (`Task #3 created…`) |
| `TodoWrite` | REPLACE — every call carries the whole list | reconstructed by `reconcileKeys` |

Supporting only `TodoWrite` was the original design and it was wrong: measured, given an explicit
"track this with TodoWrite" instruction, Claude reached for `TaskCreate` anyway — so the graph silently
fell back to one-node-per-tool-call, which reads as "the feature is broken" rather than "wrong tool".

`reconcileKeys` exists because `TodoWrite` has no ids: keying on array index churns whenever the list
grows, keying on content churns whenever an item is reworded, and either way the node you are reading
re-mounts and jumps mid-review. It matches on normalised content first, falls back to position, and
only then mints. `TaskCreate`'s real id needs none of this, which is why it is the better path.

Turns with no plan at all (quick answers, one-file edits) synthesize a node per tool call, so the
canvas is never empty.

### Gotchas
- **`fitView` fits a TARGET, never the whole graph.** The bare version was abandoned in v2 for good
  reasons that still hold — it fits against the container as it is at that instant, and this pane is a
  flex child that hasn't reached full size when nodes finish measuring (measured: zoom 0.85, column
  jammed left, never corrected); and fitting is wrong anyway for a spine that grows downward without
  limit, where a 20-step plan lands at ~0.3 zoom and nothing is readable. A session-long journey makes
  that ten times worse. So it is called with an explicit **node list** — the live milestone, else
  whatever is expanded — plus a `minZoom` floor, after a 60ms settle. **The expanded milestone's
  phases must be in that list**: framing the spine node alone put the whole fan off the bottom of the
  canvas, which reads as "clicking it did nothing much" until you think to scroll.
- **A default React Flow node has exactly one source handle.** Phases chain downward *and* fan their
  raw tool log to the right, so both necessarily leave the same bottom handle. Fanning the phases from
  the milestone instead drew eight elbows all leaving one point and travelling hundreds of pixels down
  — visual noise carrying no information. The chain costs nothing and states something true: these
  phases happened in this order.
- **The ⚙ is a sibling of the tile, not a child** — the tile is itself a `<button>`, and nesting one is
  invalid HTML whose inner click also fires the outer one. Hence the wrapper `motion.div`.
- **React Flow's stylesheet is imported from inside components**, so Next emits it *after*
  `globals.css`. Dark-mode overrides there need doubled-up selectors or they silently lose the cascade
  (measured: the controls stayed `rgb(254,254,254)`).
- A **held** prompt is answered in the canvas drawer, so `app/page.tsx` suppresses the ordinary
  permission card for it — otherwise there'd be two Approve buttons for one decision. Every non-held
  prompt still renders normally, so a Flow pane in `default` mode is no less answerable than a Chat one.

---


## 5f-bis. Message queue — `sendMessage` / `handleCommandLifecycle` in `lib/agent/manager.ts`

Typing into a pane mid-turn used to do nothing: `submit()` opened with
`if (!text || agent.busy || !cwd) return;` and the send button had already become Stop. You waited out
work you'd changed your mind about. Now a message sent during a turn is **queued** — the CLI runs it as
its own turn when the current one ends.

**Nothing in the SDK ever blocked this.** The dashboard has always run streaming-input mode
(`inputGen`), and `Query.streamInput` is a bare `for await (…) transport.write(…)` loop that drains the
iterable and writes each message straight to the CLI's stdin **without waiting for the turn to finish**.
So the transport-level queueing already worked; three things in *our* code prevented it, and only the
third was real work:

1. `submit()` dropped the message outright.
2. One button slot did double duty as Send and Stop, so there was nowhere to put "queue this".
3. **`sendMessage()` assumed every send starts a turn.** It reset `s.partial`, `s.partialThinking`,
   `sawText`, `sawThinking` and called `resetActivity()`. Run mid-turn, that truncates the reply
   currently streaming (`partial` is the buffer a reconnecting pane replays from) and wipes `liveTools`,
   so the activity line narrates the wrong work. `sendMessage` now returns early on `s.busy` after
   queueing, and that turn-start bookkeeping moves to where the *queued* turn actually begins.

### `command_lifecycle` — the undocumented channel this rests on

Knowing when a queued message begins is the whole problem, and the CLI answers it on a channel that
appears in **neither the SDK's typings nor its bundle** — an untyped passthrough from the `claude`
binary, advertised as the `msg_lifecycle_v1` capability on `system/init`. Probed shape:

```json
{ "type": "command_lifecycle", "command_uuid": "<the uuid WE stamped>",
  "state": "queued" | "started" | "completed" | "cancelled", "uuid": "…", "session_id": "…" }
```

`command_uuid` echoes back the `uuid` we put on the outgoing `SDKUserMessage` — which is why
`sendMessage` stamps one on **every** message, queued or not. Without that echo the only way to know a
queued message had started would be inferring it from turn boundaries, and that inference is wrong:
the CLI may **coalesce several queued messages into one turn**, so `completed` for an id we never saw
`start` is a real case (handled by dropping it rather than leaving a phantom in the tray).

Because it's undocumented, it's feature-detected off the capability rather than assumed, and the
`queued` list is treated as a *mirror* of the CLI's queue — never as our own holding pen. By the time a
message is in `s.queue` it has already gone down the pipe.

### Why `busy` is held across the handover

Measured: the next queued turn's `started` arrives **~2ms** after the previous turn's `result`. Going
idle in between and back to busy on `started` would flicker Stop→Send→Stop on every queued message, so
`result` skips the `busy:false` broadcast when `s.queued` is non-empty. That's a lie only if `started`
never comes — and then no result is left to clear it — so `holdForQueue()` arms a 20s backstop that
reports the drop and settles the pane rather than pinning it busy forever.

### Stop means "skip ahead", not "cancel everything"

Stop deliberately uses the **bare** `interrupt()`, never `cancel_queued: true`. The SDK guarantees the
shape we want: with `cancel_queued` absent, "queued commands survive the interrupt", and the drain loop
starts the next queued turn immediately. That makes mid-flight correction one gesture — queue the fix,
then stop the work it corrects. `interrupt()`'s receipt (`still_queued`, from the `interrupt_receipt_v1`
capability) is used only to *say* what Stop didn't stop; silence there reads as "Stop is broken" when the
pane keeps animating. Counted against our own list, since the receipt may also list ids we never sent
(cron triggers, auto-resume continuations).

> ⚠️ **Per-message cancel is not available.** `cancel_async_message` exists in the protocol and the CLI
> advertises `interrupt_cancel_queued_v1`, but neither is exposed as a public `Query` method in SDK
> 0.3.220 — `interrupt()` takes no arguments. So a queued message is committed once sent; the tray shows
> it but cannot remove it. Reaching past the public API for this was rejected as not worth the coupling.

The tray renders **beside the composer, not in the transcript**, because `reconcile()` rebuilds `turns`
wholesale from the on-disk transcript on every `result` — and a message that hasn't run yet isn't on
disk, so an inline bubble would be wiped the instant the running turn finished.

---
