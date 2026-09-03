# Live sessions — running Claude in the server

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

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

> 🐛 **"The question doesn't show up until I hit F5" (fixed 2026-08-26).** `ask` and `permission` are
> the only events in this pipeline that are **not** REPLACE semantics. Everything else — `activity`,
> `hold`, `queued` — re-broadcasts its whole value on every change, which is what makes the stated
> convention true: *a dropped SSE event self-heals on the next one*. A prompt is broadcast exactly
> ONCE, when `canUseTool` parks its promise, and the only other copy is the replay a fresh `subscribe()`
> is handed. So one lost delivery is permanent: the session sits at `phase=awaiting`, the composer says
> "waiting on your answer", and the card that answers it never comes. A reload fixes it because a reload
> re-subscribes — and nothing else did.
>
> The tell in the bug report is that both halves were visible at once: the *state* had healed (it is
> re-broadcast) while the *prompt* had not (it isn't). Cause doesn't need identifying per-incident — a
> suspended background tab, a socket the server hasn't noticed is dead, an `EventSource` that
> reconnected at the transport level without the `onopen` counter firing all produce it.
>
> Fixed client-side, because the client is where the contradiction is observable: the server says this
> pane is blocked on the user while the pane holds no prompt to show. Those two facts are broadcast
> microseconds apart, so the gap is real only in flight; sustained past `AWAIT_HEAL_MS` (4s) it means
> the prompt was lost, and the pane re-subscribes to get the replay. Once per episode, so a genuinely
> stale phase can't spin. `attach()` deliberately isn't reused for this — it ends in `ensureStream()`,
> which no-ops when a stream is already open; `resync()` drops the connection first, because replay
> happens per subscribe.
>
> Verified by fault injection: dropping a single `ask` event client-side reproduced the stranded pane
> exactly, and the watchdog recovered the card ~4s later with no reload. The happy path opened no extra
> stream at all — the server log showed one `subscribe` for a normal ask, versus one plus an
> `attach=1` for the injected one.

> 🐛 **A schema field the UI never rendered — `options[].preview` (fixed 2026-08-26).** The
> AskUserQuestion schema lets the model attach a `preview` to each option: the mockup, snippet or plan
> the one-line `description` can only gesture at. `manager.ts` broadcasts `questions` verbatim, so the
> field was *arriving* correctly the whole time — it was missing only from `AgentQuestion` in
> `lib/use-agent.ts` and from `AskCard`. 27 questions across the local transcript history had shipped
> a preview that the pane silently dropped, so a question written to be decided by comparing two
> previews arrived as two one-line descriptions with the reason to prefer either invisible.
>
> The lesson generalises past this field: **a pass-through server plus a hand-written client type is a
> place where schema additions go to die quietly.** Nothing errors — the data is simply not on screen,
> and the model has no way to learn that what it sent was never shown.
>
> The preview renders *inside* the option row, in the card's one scrolling region, never as a new
> pinned block. That is a direct consequence of §"AskCard layout": the card is clipped rather than
> scrolled by its pane, so any block of arbitrary length placed outside that region can push "Send
> answer" off the bottom — and an unanswerable ask holds the session at `phase=awaiting`, which is busy
> forever (§8). Open/closed state defaults to following the selection (the schema's "focused" semantics
> with a mouse) with an explicit per-option toggle that overrides in both directions, so several
> previews can be compared side by side without committing to any of them.

**Permission modes are enforced here, in `canUseTool` — not by the SDK.** Each session carries its own
`s.mode`, and the hook decides before it ever prompts: `bypassPermissions` allows everything,
`acceptEdits` allows the edit tools (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`), everything else asks.
`AskUserQuestion` is exempt from all of it — it isn't a permission, it's Claude asking the human a
question, and auto-answering it would throw the question away. The mode is still handed to the SDK at
spawn time *and* on change, so the CLI's own state agrees; it just isn't trusted to be the enforcer.

**The model is creation-only, so the composer's picker respawns rather than asks.** `query()` is built
around a model and there is no control message to move a warm session onto another one — the same shape
of trap as `setPermissionMode()` above. `setModel()` therefore closes the SDK subprocess and the pane's
next send carries `resume`, so the conversation is picked back up *off disk* — the mechanism a pane
reattaching after a server restart already depends on. What does not survive is anything that only
existed inside the old process: queued follow-ups, parked permission prompts (`closeSession` denies
them), and the KV cache, so the first turn after a swap is a cold read of the transcript. It refuses
mid-turn, because killing a streaming subprocess loses the tail of the reply (`s.partial` until
`result`) and orphans any running tool call.

Two details are easy to get wrong and both were:

- **The live SSE subscribers have to be handed over.** They live in the `Session` object `closeSession`
  deletes, and `ensureSession` starts a fresh one that only adopts from `waiting` — so without moving
  them there, every pane watching that key goes silent until reloaded, which looks like the swap hanging.
- **`sentOnce` must be re-armed client-side.** It is what decides whether the next send passes `resume`;
  it is true for any live pane, so missing it makes a model swap start a brand-new, context-less session
  that looks like the same chat.

The picker names the model the *session reported at init*, never one derived from a client-side copy of
the pin — `lib/model-pins.ts` reads `~/Minami`'s config with `node:fs` and cannot be imported into a
browser component, and mirroring the id to render a label is exactly the drift that file exists to
prevent. "Chosen but not yet running" is likewise derived, from the pick and the reported model
disagreeing, rather than announced: a `notice` cannot work here at all, since `NoticeStrip` renders only
while a pane is busy and the swap is refused while busy.

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

### The system-prompt append: preview contract, fan-out, browser nudge (2026-09-02, context guardrail 2026-09-03)

Every session's `query()` carries `systemPrompt: { preset: "claude_code", append }` built from up to
three pieces. It used to ride inside the `MCP_SERVERS` spread — an accident of birth (the browser
nudge was the only append), and it silently meant a `MINAMI_DISABLE_BROWSER_TOOL=1` install got *no*
append at all. Now the append is unconditional and only its pieces are gated:

- **`PREVIEW_PROMPT`, always.** The ending contract: a reply that produced something viewable ends
  with a fenced ` ```minami-preview ` block of `{kind: url|file|cmd, target, label}[]`. The shell
  strips it and renders chips (§5c). This lives in the manager, not a skill, because a skill loads
  when the model thinks it's relevant and an ending convention only works if it is unconditional.
- **`FANOUT_PROMPT`, when the pane's fan-out pill is on (the default).** "Propose parallel subagents
  for divisible work and proceed — the user pre-approved by enabling the mode." The pill's OFF state
  is the marked one in the UI for the same reason. Fallback for panes that never chose:
  `MINAMI_DASHBOARD_FANOUT` (unset/1 = on). The fuller procedure lives in the user-level `fanout`
  skill (`~/.claude/skills/fanout/`), which is on the box, not in this repo.
- **`BROWSER_PROMPT`, when the browser MCP is registered** — unchanged.
- **`CONTEXT_PROMPT`, always (2026-09-03).** A session watching its own context shrink invented
  remedies: one rationed its replies ("it's a fresh session with the spec"), and in a vault cwd the
  nearest thing named "compact" is the VAULT's consolidation — chat-6's stranded branch carried two
  vault-compaction commits born exactly that way. The append says: keep working, the harness
  auto-compacts at `AUTOCOMPACT_PCT`%, and file-level "compaction" (vault routines, memory skills)
  runs only on explicit request, never as a context remedy. The visible half is the composer's
  context meter: `s.ctxUsed` (input + cache reads/writes of the newest TOP-LEVEL assistant message —
  a subagent's usage describes its own context, not the main loop's) rides a REPLACE-semantics
  `ctx` event plus the reconnect snapshot; the window is derived client-side from the session model
  (`contextWindowFor`, lib/model-catalog.ts — 200k Haiku, 1M otherwise, unknown→1M so the meter errs
  late rather than crying early). Amber at 45%, red at 80%; clicking sends `/compact`, the CLI's own
  manual compaction, whose `compact_boundary` the pane already narrates.

`fanout` rides on every send like `model` and is creation-only for the same reason: an append can't
be edited on a warm query. Mid-chat toggles go through `POST /api/agent/fanout` → `setFanout()`,
which is `setModel()`'s twin — refuse while busy, otherwise teardown with the same
subscriber-handover into `waiting`, `respawned: true`, and the client re-arms `resume` so the next
send picks the conversation back up off disk under the new prompt.

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

### Memory: an open tab used to pin every pane's subprocess forever

Each live pane holds a `claude` subprocess measuring **~330–410 MB**. The idle reaper (`IDLE_REAP_MS`,
30 min) is armed **only when a session's subscriber count reaches zero** — `unsubscribe()` is what calls
`scheduleIdle`, and `scheduleIdle`'s own callback returns early on `subs.size !== 0`. A visible pane's
EventSource is always a subscriber, so a tab left open all day reclaimed *nothing*, no matter how idle.

Measured on this box during the audit: 16 GB machine, **81 MB free**, ~22 GB of logical memory
compressed into 5.5 GB, **6.0 of 7.2 GB swap in use**, and `kernel_task` at 20% doing the compression
and swap I/O. That is what makes the machine hot — not dashboard CPU, which is negligible
(`next-server` ~3%, polled endpoints 10–20 ms, idle page **0 long tasks / 0% main thread**).

**The trigger is inactivity, not hiding.** Hiding was only the obvious case: a pane sitting *visible and
untouched* pins ~400 MB exactly as hard, and measurably did — with two agents on the box, one idle
session held 388 MB while the machine sat at **71 MB free**. `use-agent.ts` unpins after
**5 minutes idle**, or **1 minute** when the tab is also hidden (nobody can be reading it).

What makes the short fuse safe is that **unpinning is nearly free**. It only drops the SSE subscriber;
the session stays warm until the server's own 30-minute reaper decides otherwise, so returning inside
that window costs one reconnect and nothing else. Only a pane left for `UNPIN_IDLE + IDLE_REAP` actually
pays a cold start — which is precisely the trade `IDLE_REAP_MS` already encodes for every session the
dashboard isn't watching. Any `pointerdown`/`keydown` re-attaches immediately and restarts the clock, so
a pane resyncs the moment you touch it.

It never releases mid-turn or over an unanswered prompt (a parked permission promise is auto-denied when
the session is reaped, so releasing would answer for the user); the next tick re-checks, so a long
unattended turn is still released once it lands. Coming back re-attaches down the same path a refresh
takes: session alive → snapshot; reaped → `detached`, falling back to disk with `resume` re-armed.

One **structural** note: this is a single 30 s interval reading state through refs, deliberately not a
chain of per-transition `setTimeout`s. The first version was the latter and lost its pending timer
whenever the effect re-registered — a bug that presented as "the release never fires", which is
indistinguishable from a logic error until you instrument it.

> ⚠️ **Verify this by watching the subprocess, not by reasoning — and watch long enough.** A first
> attempt looked like a total failure (subprocess still alive 30 s after release) and was nearly
> diagnosed as a broken client. It wasn't: `scheduleIdle` **re-arms** rather than firing once, so the
> reap landed at ~40 s. The way to tell a broken release from a slow one is to count sockets —
> `lsof -nP -iTCP:<port> -sTCP:ESTABLISHED` dropped 5 → 3 at release, proving the client half worked
> while the reaper was still cycling.

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

### Subagents: the AgentBoard, and per-agent `since` (2026-09-02)

A fan-out used to render as 9px pills on the status line — agent *type* only, so four parallel
"Explore"s were indistinguishable, and the roster wrapped into a jumble. Full-size panes now render
**AgentBoard** (app/page.tsx): one row per running agent — pulsing bot, type badge, the actual
*assignment* (`description`), the inner tool it's currently on (`task_progress.last_tool_name`), a
tool-use count, and a per-agent timer. Finished agents stay in the same list, dimmed with ✓/✗/⏹
(their data comes from the "task" notices, same as the old finished-pill row — hover for the full
summary). This is the third design: full-sentence notice lines → inline pills → the board.

`LiveTask.since` is stamped server-side at `task_started` for the per-agent timer — the turn's
shared elapsed says nothing about which agent has been grinding. Deliberately absent on background
tasks adopted from a `background_tasks_changed` REPLACE snapshot: their true start predates our
first sight of them, and a fabricated timestamp would render as a confident lie. The rows tick
without their own interval because every full-size ActivityLine caller already re-renders on the 1s
elapsed tick.

> 🐛 **A background agent vanished at the turn boundary (2026-09-03).** A reply ending "waiting on
> C's sweep" sat next to a pane showing nothing about C: the `result` handler's `resetActivity`
> cleared `liveTasks` unconditionally, but a `run_in_background` agent OUTLIVES the turn — any
> entry without its `task_notification` at `result` time is still running by definition (foreground
> subagents always notify first). Fix, both halves: `resetActivity` takes `keepTasks` (only the
> result path uses it; teardown still clears, because a dead subprocess takes its agents with it)
> and the turn ends in phase `tool`, not `idle`, while survivors exist — which also keeps the 1s
> client tick alive for their clocks. The pane renders the same AgentBoard in the banner slot when
> idle-with-agents, with a 3-minute grace window after the last landing so the ✓/✗ verdict is seen
> rather than vanishing with the fleet.

One-line contexts (tile, cramped status) don't get the board; `taskLabel` instead says
`4 agents · Explore ×3, Plan` (counts by type) rather than the old `subagent (Explore) +3`, and a
single agent shows type AND clipped assignment.

Second pass, same day — the board became **the bay**: one bordered container with a header
(the *formation strip*: one breathing dot per running agent, parked solid when it lands) and rows
on a shared 6-column grid, so a fleet aligns into a scannable table instead of ragged flex rows.
Motion follows the pane's honesty rule (motion = a real event): `agentIn` on a row is a real
launch, `agentBreathe` staggers by NEGATIVE delay (no dot waits dead for its first cycle, and the
fleet doesn't strobe in sync — tempo matches activityShimmer's 2.4s so the live area inhales
together), the current-tool and tool-count cells are KEYED on their text so the remount itself
animates exactly when the agent moved, and `agentLand` pops the verdict glyph when a result
actually arrives. All four classes are in the `prefers-reduced-motion` block. Meta cells render
even when empty so columns hold their line.

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
