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
