# Flow — the step graph, its brake, its queue

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 5f. Flow — `components/FlowCanvas.tsx`, `components/FlowStrip.tsx`, `lib/flow-model.ts`

The plan you're already looking at, opened up: the same TodoWrite/TaskCreate steps the chat shows as a
checklist, expanded so each one carries the work it did, with a brake that can stop the next tool call.
It exists to catch a bad step *mid-flight*, which is the one thing the transcript cannot help with.

### Three revisions, and what each one actually got wrong

**v3 (current) is what was asked for from the start:** the graph lives in the **bento column**, and a
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
- **`fitView` is not used, deliberately.** It fits against the container as it is at that instant, and
  this pane is a flex child that hasn't reached full size when nodes finish measuring — measured
  result: zoom 0.85, column jammed left, never corrected. Chasing it with a `ResizeObserver` only moves
  the race. And fitting is wrong anyway for a spine that grows downward without limit: a 20-step plan
  would fit at ~0.3 zoom, where nothing is readable. A fixed viewport at zoom 1 is the review surface.
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
