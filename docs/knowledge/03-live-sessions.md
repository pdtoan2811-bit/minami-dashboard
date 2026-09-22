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

**`ask_team` is the other kind of question, and it is deliberately *not* parked at the gate.**
Added 2026-09-21. `AskUserQuestion` is Claude asking the person at the keyboard; `ask_team` is Claude
asking a *teammate* — the **team-ask** MCP server (github.com/Anhduchb01/team-ask, ducba's; installed
at user scope on this box from `~/dev/team-ask`). It posts an AskUserQuestion-shaped card to that
person's Slack DM and blocks the tool call until they pick rows and hit Send (or reply in the thread),
up to `ASK_TIMEOUT_MINUTES` (360 here). Each Claude session holds its own Socket Mode connection —
there is no hub, no public URL, and **no API through which anything else can answer**.

So the dashboard's part is a read-only mirror. `manager.ts` spots the tool in the top-level
`tool_use` stream (`isAskTeamTool` in `labels.ts`, suffix-matched because the `mcp__<server>__`
prefix is whatever `claude mcp add` was given), keeps it on `s.askTeam`, and broadcasts
`{t:"ask_team", packet}` — REPLACE semantics, `packet:null` when the `tool_result` lands. It rides
the snapshot, so a pane that reattaches mid-wait gets the card back instead of "running a tool" for
an hour. `AskTeamCard` draws topic → where → each question → options with consequences, the same
order as the DM card, and says where to answer. The activity label reads "asking the team on Slack:
<topic>" for the same reason: a session waiting on a person should not look like a wedged tool.

Two things worth knowing. Dashboard sessions get the tool because `settingSources` includes `user`
— it's the same `~/.claude.json` registration a terminal `claude` uses, so nothing in this repo
configures it. And team-ask's `RECONCILE`/relay design means an answer can land on *another* of
this box's sessions' Socket Mode connections and take up to 20s to be relayed; that latency is
team-ask's, not ours. **Socket Mode caps an app at 10 connections**, and every live pane is one —
the dashboard's usual four to six panes are most of that budget on their own.

**Forwarding, and why the dashboard grew no Slack code to do it.** Added 2026-09-22. A question
Claude asks *you* (`AskUserQuestion`) may be one only the CTO can settle, and before this the pane
offered three bad exits: guess, skip it (Claude guesses), or leave the card unanswered — which pins
`phase=awaiting`, busy forever, starving every deploy on the box (§8). So each question on `AskCard`
now carries a **"Not mine →" row** of teammates, and picking one resolves *that question* with an
instruction to go ask that person with `ask_team`. Per question, not per card: answer two yourself
and hand the third to trungld in the same Send.

The dashboard has no Slack token and deliberately doesn't get one. team-ask is already an MCP server
the session holds, so the cheapest correct move is to answer Claude's own question with *"Not my
call — ask X, use the ask_team tool with assignee …, wait for their answer"*. One Slack integration
on this box instead of two; it works identically in a pane, a terminal or a headless agent; and the
`ask_team` mirror card above is what then appears, so the hand-over is visible. The cost is that it
depends on Claude following an instruction rather than on a call we make ourselves — accepted,
because the alternative is a second Socket Mode connection per pane against a 10-connection app cap.

The roster is **read from team-ask's own `team.json`** (`lib/team-roster.ts`, `MINAMI_TEAM_ASK_DIR`,
default `~/dev/team-ask`), minus whoever is at this machine (`CC_ASK_ME`, read from that same repo's
`.env`). A copy of the list here would drift, and drift means a question sent to the wrong person. No
team-ask on the machine → `[]` → the row doesn't render and the card is exactly what it was.

> 🐛 **`expired_trigger_id` — the modal that only opens on the machine that asked (found 2026-09-22).**
> team-ask's own forward button opened a Slack *modal*, and a modal needs a `trigger_id` that dies
> 3 seconds after the click. Slack hands each `block_actions` to ONE of the app's Socket Mode
> connections at random, and every Claude session is a connection — so the click routinely lands on a
> process that must then do work before opening anything. Measured on the first real click: the
> foreign connection received it and `views.open` returned `expired_trigger_id`. The button silently
> did nothing. The same trap sits under the "Other / type your own" modal, which is why that one
> now names the thread as its fallback in words. Fixed for forwarding by not needing a trigger at
> all: the fallback is a `users_select` inside an **ephemeral message**, which has no time window.
> The lesson generalises: *in a multi-connection Socket Mode app, anything that depends on
> `trigger_id` is best-effort, and needs a path that isn't.*

Why this isn't the same path as `AskUserQuestion`: a first cut (same day, reverted within hours)
built a Cloudflare Worker "hub" the pane could answer through, so the pane and Slack raced. It was
dropped the moment ducba's team-ask existed — one tool the whole team already runs beats a second
one that needs its own Worker, Slack app and secrets. What survived is the mirror.

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

**A premium pick is deliberately not sticky (2026-09-07).** `setModelPick` wrote the choice to the
pane's key *and* to the global `bento:chatModel` seed, exactly like `setPermDefault` — so one
considered "use Fable for this hard thing" silently became the birth model of every chat opened in
that browser afterwards, with no expiry and nothing to notice it by (the pill is a 10px label in a row
that folds). That one line was the whole shape of the 2026-09-03 incident. A 2× tier should be a
decision made per conversation, so a premium pick now leaves the seed pointing at the box pin and stays
where you put it. The pill's own always-on alarm is the other half: it goes amber with a ⚡ and reads
off `sessionModel` — **what the server says is running** — so a stale localStorage pick cannot talk it
out of the truth, and the dropdown row carries "⚡ 2× · this chat only".

### `resolveModel()` — the one place a model id is decided (2026-09-07)

Every spawner funnels through `ensureSession`: the composer, `lib/agents/runner.ts`, the autopilot's
conflict resolver, and teams (via agents). So `resolveModel()` sits there and is the **single choke
point** — an id not in `SELECTABLE_MODELS` is treated as debris and coerced back to `DEFAULT_MODEL`,
and the pane is told so with a `notice{kind:"model"}`.

Before this there was **exactly one** model validation in the whole app, in `/api/agent/model` — the
picker's route. `/api/agent/send` carries the pane's stored id on **every** send and passed it straight
to the SDK, unvalidated; its own comment documented the gap as deliberate. That was the hole the
2026-09-03 incident went through (§6): a stale `claude-fable-5`, orphaned in localStorage when the
catalog moved to `fable-5-1`, kept riding every send for a whole session at ~2× Opus price while the
pill read "default". **An id that isn't in the catalog is not a preference, it's debris** — and falling
back *silently* is how the first bug hid, so the fallback announces itself.

A premium birth gets its own notice. It lands at the start of the first turn while the pane is busy,
which is the only window `NoticeStrip` renders in and exactly the moment the fact is still actionable
(stop, switch, resend).

**`Session.observedModel` is kept separate from `Session.model`, and that separation is load-bearing.**
The SDK's `init` message is the only witness to what the request actually *resolved* to; the manager
used to broadcast it to the browser and throw it away server-side, so "asked for Opus, got something
else" was unobservable the moment a pane reattached — and the box-wide alert can't read a browser
anyway. Writing it into `s.model` is the tempting one-liner and it's wrong: `setModel()` compares
against `s.model` to decide whether a pick actually changed, so an alias resolution would read as a
user model change and respawn the session. The mismatch notice compares by **family**
(`claude-fable-5-1` → `fable`) — the CLI resolving an alias to a dated id for the same model is not
drift; landing in a different family is.

`liveModels()` exports the runtime half of the question the config check cannot answer — see §6 for
why the two halves both exist and how `AccountStatus` ranks them.

#### The second gate: the runtime is `node_modules`, not `PATH` (2026-09-08)

A model can be in the catalog, current, correctly spelled, and still be **rejected with a 400
mid-turn**, after the user has already spent a message. `resolveModel()` therefore has two gates, and
they answer different questions:

1. **Is the id one this app offers** — `isSelectableModel()`. An off-catalog id is debris (above).
2. **Can the runtime run it** — `meetsMinCli(sdkClaudeVersion(), entry.minCli)`.

Either gate falls back to `DEFAULT_MODEL` and returns a `reason` string, so the `notice{kind:"model"}`
says *which* gate rejected the pick — "needs Claude Code 2.1.251 and this server's Agent SDK bundles
2.1.220 — bump `@anthropic-ai/claude-agent-sdk` to use it" — rather than announcing a bare
substitution. That converts a dead turn into a sentence.

**The version that governs this is a property of `node_modules`, not of `PATH`.** The Agent SDK ships
and spawns its *own* Claude Code binary — not a version string in a manifest but a real 200–250 MB
executable at `node_modules/@anthropic-ai/claude-agent-sdk-<platform>/claude`, whose sibling wrapper
package carries the matching `manifest.json`. That binary is what every dashboard chat on this box
runs on. The `claude` on `PATH` — measured at `/opt/homebrew/bin/claude`, **2.1.241** — serves
interactive terminal sessions and has no say here. The only way to move the number is to bump the npm
dependency and redeploy.

> **Upgraded 2026-09-14: 0.3.220 / CLI 2.1.220 → 0.3.270 / CLI 2.1.270.** Running the binary directly
> confirms it (`…-darwin-arm64/claude --version` → `2.1.270 (Claude Code)`). Before the bump the box
> had **three different Claude Codes** on it — 2.1.220 for dashboard panes, 2.1.241 on `PATH`, 2.1.270
> in the Desktop app — and the dashboard's was seven weeks and ~50 releases behind.
>
> **How it was found is the reusable part: one transcript spanned both runtimes.** Every row in a
> session JSONL carries `entrypoint` and `version`, so
> `/Users/thomas/.claude/projects/…/61658e33-….jsonl` records `claude-desktop`/`2.1.270` for its first
> 81 minutes and `sdk-ts`/`2.1.220` for the last 8 — same conversation, same model, same effort, 50
> releases apart. **Grouping any transcript by `entrypoint` is the cheapest available A/B of the
> dashboard against stock Claude Code**, and it needs no instrumentation.
>
> Two install hazards, both real on this box:
> - `NODE_ENV=production` is set in the shell here, so a bare `npm install` prunes every devDependency
>   and silently removes `typescript` — which breaks every `@/` alias with an error that names neither.
>   Install with `NODE_ENV=development npm install --include=dev`, then verify the devDeps survived.
> - **The wrapper JS is loaded in memory by the running server; the binary is resolved from disk at
>   spawn time.** So between `npm install` and the next deploy, a NEWLY created session pairs the OLD
>   wrapper with the NEW CLI. `manifest.json`'s `sdkCompat.testedWrapperVersions` is exactly the list
>   that pairing has to be in — 2.1.270's is `0.3.229 … 0.3.269`, which does **not** include 0.3.220.
>   Check that list before installing, and deploy promptly afterwards. Already-running sessions are
>   safe: their process holds an open fd to the replaced binary.
>
> Consequence for the catalog: `claude-fable-5-1` carries `minCli: "2.1.251"`, so it was unselectable
> in the dashboard and selectable in Desktop. Both can now run it.

- **`lib/runtime-version.ts`** (new) reads that manifest, 60s cache — a dependency bump needs a redeploy
  anyway, so the TTL is churn control, not freshness. **The null contract is the load-bearing part:**
  `sdkClaudeVersion()` returns `null` when it can't tell, and every caller must read null as *"no reason
  to block"*, never as *"blocked"*. An SDK package layout change must not silently strip the picker to
  nothing.
- **`meetsMinCli()` compares numerically, per segment.** A string compare gets `"2.1.9" > "2.1.251"` —
  and being wrong here re-enables the exact model that 400s, which is the failure this whole gate exists
  to prevent. Missing `min` or unknown `version` → `true`, same contract.
- **`GET /api/agent/runtime` → `{ cliVersion }`** (new) is its own tiny route rather than a field on
  `/api/accounts`: the picker is not an account surface, and hanging a model question off the
  token-slayer bridge would couple a dropdown to a poll that can 502 when the CLI isn't installed.
- **The picker fetches it lazily, on first dropdown open** (`ModelPicker`, `app/page.tsx`). It can only
  change with a redeploy, so paying for it on mount in every pane is waste. `undefined` = not fetched;
  only a *known*-too-old runtime disables a row. Disabled rows are greyed **and labelled** "needs CLI
  2.1.251", with a tooltip naming the real remedy — a greyed row with no reason reads as a bug in the app.

**`claude-fable-5` is back in the catalog as a selectable `premium` row**, and not out of nostalgia: it
is the only Fable this runtime can actually run (verified — 641 turns ran on it on this box across
2026-09-02..04). Removing it would leave the box offering a Fable that cannot work and no Fable that can.

Verified by measurement: all 9 `meetsMinCli` cases pass, including the `2.1.9` vs `2.1.251`
string-compare trap and both null cases; and against the really-bundled 2.1.220, Opus 5 / Sonnet 5 /
Fable 5 / Haiku 4.5 resolve `runnable=true` while Fable 5.1 resolves `runnable=false`.

> 🐛 **The error told you to update the wrong binary (2026-09-08).** Picking "Fable 5.1" in a pane killed
> the turn with `API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.251 or newer
> is required. Run 'claude update', or update the Claude desktop app, then try again.` Every noun in that
> remedy is wrong on this box. `claude --version` was already **2.1.241** — newer than the 2.1.220 the
> error names — and `claude update` would have changed nothing, because the 2.1.220 doing the rejecting
> lives in `node_modules`, not on `PATH`. There is no desktop app in this path at all. Following the
> message would have cost an afternoon and ended with the same 400.
>
> Two failures stacked. The **diagnostic** one: an error that names a version implies you can go read that
> version somewhere, and the obvious place to look is the thing you'd type. The dashboard couldn't correct
> it because the app had no idea what version it was spawning either. The **timing** one: the check
> happened inside the model, so the price of a wrong pick was a spent message and a dead turn rather than
> a disabled row. Both are answered the same way — measure the binary that will actually run
> (`sdkClaudeVersion()`), and decide *before* the send instead of learning it from the API.
>
> This is the index's pattern in a new costume: `claude --version` looks authoritative and is only a claim
> *about a different process*. The thing that cannot lie is the manifest of the package that gets spawned.

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
- **`BLACKSMITH_PROMPT`, when the pane's ⚒ pill is on (2026-09-14).** Turns the pane into the operator
  console for the Blacksmith agent factory. Off by default (`MINAMI_DASHBOARD_BLACKSMITH=1` flips the
  fallback) because it is long and names a clone most installs don't have. Why it is a mode and not a
  skill: Blacksmith's own `/bs` skill states that it "never calls an LLM directly and never embeds a
  role prompt" — every coder, reviewer and verifier is hand-spawned by an operator — so the session
  has to know it IS the dispatcher, and a skill that loads when the model thinks it's relevant cannot
  establish that. Full reasoning in **§20**.
- **`repoBriefing()`, when the cwd is a git checkout (2026-09-07).** Placed *ahead* of the behavioural
  rules, because it is measurement rather than instruction: which branch this checkout is really on,
  which remote trunk is actually moving, how far behind it is, and when origin was last fetched. Read
  from `cachedRepoState()` — sync, cache-only, because `ensureSession` builds the whole `query()` in one
  synchronous breath and must not wait on git; `/api/agent/send` awaits `primeRepoState()` first to fill
  that cache. A miss is a briefing one turn late, never a stall. Full reasoning, and the five-hour
  dead-branch incident it exists for, in **§19**.
- **`CONTEXT_PROMPT`, always (2026-09-03).** A session watching its own context shrink invented
  remedies: one rationed its replies ("it's a fresh session with the spec"), and in a vault cwd the
  nearest thing named "compact" is the VAULT's consolidation — chat-6's stranded branch carried two
  vault-compaction commits born exactly that way. The append says: keep working, the harness
  auto-compacts at `AUTOCOMPACT_PCT`%, and file-level "compaction" (vault routines, memory skills)
  runs only on explicit request, never as a context remedy — and (added same day, with evidence)
  never SELF-ESTIMATE remaining context: a session declaring "I'm near the end of my context" was
  measured at 83k of 1M — **8%** — with zero compactions ever fired on this box. Manual `/compact`
  was verified end-to-end the same day (recorded as a real local command; the ~$0.13 result is the
  summarization call itself).

  > 🐛 **The SDK's autocompact never fires in server-driven sessions (found 2026-09-04).** An
  > oe-central-ver2 session sat at **73% (728k/1M)** with `autoCompactEnabled: true`, the env
  > override at 60%, and zero `compact_boundary` rows in any transcript on the box — the settings
  > were correct and irrelevant. Fix in the house style (`canUseTool` enforces permission modes the
  > SDK is told about but not trusted with): **`maybeAutoCompact()` makes the server the enforcer.**
  > At an idle turn end past `AUTOCOMPACT_PCT`% of the model's window it injects the user-side
  > `/compact` the CLI demonstrably honours, with a notice first. The re-fire guard is
  > `lastAutoCompactCtx`: try again only once the context has GROWN past the last attempt — new
  > evidence, not the same evidence louder. Runs before `placementPass` so its send occupies the
  > queue and the pass stands down for that boundary. Second half of the incident: asked in prose to
  > compact, the model REFUSED — `/compact` is a user-side command the model cannot run, and the
  > guardrail against vault-compaction read as "don't compact, period". `CONTEXT_PROMPT` now says an
  > explicit user ask is always legitimate: point at the meter or `/compact`, never refuse. The visible half is the composer's
  context meter: `s.ctxUsed` (input + cache reads/writes of the newest TOP-LEVEL assistant message —
  a subagent's usage describes its own context, not the main loop's) rides a REPLACE-semantics
  `ctx` event plus the reconnect snapshot; the window is derived client-side from the session model
  (`contextWindowFor`, lib/model-catalog.ts — 200k Haiku, 1M otherwise, unknown→1M so the meter errs
  late rather than crying early). Amber at 45%, red at 80%; clicking sends `/compact`, the CLI's own
  manual compaction, whose `compact_boundary` the pane already narrates.

`fanout` and `blacksmith` ride on every send like `model` and are creation-only for the same reason:
an append can't be edited on a warm query. Mid-chat toggles go through `POST /api/agent/fanout` →
`setFanout()` and `POST /api/agent/blacksmith` → `setBlacksmith()`, both `setModel()`'s twins —
refuse while busy, otherwise teardown with the same subscriber-handover into `waiting`,
`respawned: true`, and the client re-arms `resume` so the next send picks the conversation back up
off disk under the new prompt. **Three members of one family now; a fourth should be the same shape,
not a new one.** The trap they all exist to route around is worth restating: a system-prompt append
is fixed at `query()` creation, so "apply this to the running session" is not a thing that can be
done, only simulated by replacing the process and resuming from disk.

Two asymmetries between them, both deliberate. Fan-out seeds a global default from the per-pane
choice (`chatFanout` ← `chatFanout:<key>`), Blacksmith does not: driving the factory is something you
do in one pane about one epic, and silently making every future chat an operator console would put a
long, specific prompt in front of unrelated work. And the pill polarity is inverted — fan-out is lit
when OFF (the marked state is opting out of a default), Blacksmith is lit when ON.

> 🐛 **`askBrowser()` dropped the pane's mode flags (found and fixed 2026-09-14, incidentally).** The
> browser panel's own send path passed `model` but not `fanout`, so a session born cold from that
> path silently got `DEFAULT_FANOUT` instead of the pane's pill. Latent rather than reported — it only
> bites when the browser-ask is the FIRST send of a pane — but it is the exact failure mode the
> "rides on every send" rule exists to prevent, and it survived because the rule lived in a comment
> on one call site rather than being checked at all of them. Both flags now ride every `agent.send()`.

### Gotchas
- **A new `notice` kind needs a tint or it renders grey.** `NOTICE_TINT` in `app/page.tsx` maps kind →
  colour and falls back to `#9ca3af`, so a kind added server-side without a row there is not an error,
  just a notice that silently loses its severity. `model` and `repo` (both added 2026-09-07) are amber,
  alongside `limit` / `denied` / `restarting`.
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

### Two clocks, because one of them was answering the wrong question (2026-09-14)

`ActivityState` now carries **`turnMs`** alongside `elapsedMs`, and the distinction is the whole point.

`elapsedMs` is PHASE-elapsed: `touch()` restarts `phaseSince` whenever the phase changes, and the
client restarts its own anchor whenever the phase *or the label* changes. During tool-heavy work that
is several times a second — tool → `settle()` → thinking → tool — so the only number the UI had
almost never passed ten seconds. **A wedged five-minute `Bash` and a fast one rendered identically**,
which is precisely the "is this thing still running?" confusion the user reported. It was never a
missing feature; it was a number that looked like an answer and wasn't.

`turnMs` restarts only at a real turn boundary, from `Session.turnStartedAt`, set on the same tick as
`busy` in all three places a turn can begin — a fresh send, `command_lifecycle: started` promoting a
queued message, and the ~2ms result→handover gap. Anything that clears `busy` clears it too, or an
idle pane inherits a clock running since the last turn. Started at the send rather than at the first
SDK event on purpose: a cold start is a second or two of that turn and the most anxious part of it.

The client re-anchors `turnStart` only when the implied start MOVES by more than 2s. Every broadcast
carries a freshly computed `turnMs`, so re-deriving unconditionally would let network jitter walk the
displayed start back and forth — which on the clock that is supposed to be the steady one reads as a
glitch. A real boundary moves it by far more than the tolerance.

**Tiles get `turnStartedAt`, not `turnMs`.** `liveActivity()` has always omitted `elapsedMs` because a
value that changes every poll defeats the bento grid's change-detection and re-renders the whole
framer-motion grid every 1.5s. A fixed timestamp has the opposite property: the poll sees a steady
object while the tile counts up from it locally (`TurnClock`, isolated into its own component so its
1s tick repaints 40 characters instead of the grid).

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

### The tasks panel — the fourth design, and the first with a ledger (2026-09-14)

`components/TasksPanel.tsx`, a third tab in the pane's shared side slot beside Browser and Files,
modelled on Claude Desktop's *Background tasks* panel. The board (above) stays as the glance in the
transcript; this is where you go when one line per agent isn't enough. Cards, not rows: title,
kind (Agent / Bash / Workflow / MCP), elapsed, and for agents the **model, token spend and tool-use
count**, plus the current step. A **Finished N** section collapses below, with a clear button. The
door in is a `N running tasks` pill in the composer's status line — the same affordance Desktop has,
and it earns its place: a tab in a slot that may be hidden is a panel nobody opens.

What made it possible is SDK 0.3.270's task events (§3 runtime bump, same day). `task_started` now
carries `task_type`, `is_backgrounded`, `spawn_depth`; `task_progress` carries
`usage.{total_tokens,tool_uses,duration_ms}` and a model-written `summary`; `task_notification`
carries the final usage. `LiveTask` grew to match, and a `task_end` event carries the finished
record. `task_updated` patches are applied for `description` and `is_backgrounded` only — its
`status` is deliberately ignored, because the terminal states arrive as `task_notification` with the
usage attached, and honouring both would finish a task twice.

Two things are genuinely new capabilities rather than re-layout:

- **Per-task stop.** The card's ■ calls `stopTask(key, taskId)` → the SDK's `query.stopTask()`,
  which ends one agent and leaves the turn running. The pane's Stop interrupts the whole query and
  kills every task with it — a different tool for a different intent. Bounded at 8s like `interrupt()`,
  and it touches nothing locally: the SDK's own `stopped` notification flows back through the normal
  path, so there is one way a task ends.
- **View transcript.** Reads the subagent's own JSONL — see §1 for the sidecar the read pipeline had
  never opened. Works live (the file is appended as the agent runs; the view re-fetches every 4s) and
  after, which is the point: once a turn ends, the parent transcript keeps only the Task tool's capped
  result.

**The model isn't on any task event.** It IS on the subagent's transcript, one row in, so
`resolveTaskModel()` reads the head of that file — on `task_progress` (throttled to one attempt per
3s per task, since progress can fire several times a second) and, forced, on `task_notification`.
The second call exists because of a measured gap: an agent that uses no tools never emits progress,
so a 7-second "reply ok" agent finished with no model. Both lookups are best-effort and never block.

> 🐛 **A backgrounded command rendered twice (caught in the probe, 2026-09-14).** The SDK says the
> level signal (`background_tasks_changed`) precedes the edge (`task_started`) "in practice", and it
> does: the command was adopted under its `bg:<id>` placeholder, then registered again under its real
> id. `task_started` now retires the placeholder first. Also from the same probe: the placeholder had
> been stuffing `task_type` into `agent`, so a bash task wore a `local_bash` type badge — `agent` is
> now only set for agent kinds.

`TaskCard` is deliberately not memoized. Its clock is `Date.now() - since` driven by the panel's 1s
tick, and the task prop's identity doesn't change between ticks — a memo would freeze every running
card at the second it mounted.

Verified end-to-end 2026-09-14 on the iterate server with a Haiku probe: one `run_in_background`
Bash and one Explore agent. Agent card: `completed · 7,053 ms · 9,753 tokens · "ok"`; bash card:
`completed` with the CLI's summary as its result; transcript route returned the right file, the model,
and both turns. Not exercised: the ■ under a genuinely long-running task, and the panel under a fleet
wider than two.

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

### The heartbeat, and why the old one couldn't be seen (2026-09-14)

The stream route always sent a keepalive every 20s — as an SSE **comment frame** (`: ping`). That
keeps the socket warm and is invisible to `onmessage` by specification, so the client had no evidence
of liveness at all. The consequence was a pane that could not tell "a long `Bash` is running" from
"the stream is dead and this is a photograph": both are silence, and silence rendered as bouncing
dots, shimmering label and all, indefinitely. `es.onerror` was an empty comment, and `detached` was
computed by the hook and rendered nowhere.

Now it is a real event — `{ t: "beat", at }` every **10s** (`HEARTBEAT_MS`). The client stamps
`lastSignalRef` on *every* frame (before the switch, so an event it doesn't understand still counts)
and a 2s watchdog flips `link` to `"stale"` after `LINK_STALE_MS` (26s — two missed beats plus slack).
`onerror` additionally flips it immediately when `readyState === CLOSED`, the one case the browser
will never retry. Verified on a live stream: 3 beats in 36s at 9–10s intervals.

Stale outranks every other status the pane can show — the composer's `● live` and the ActivityLine's
label both give way to it, because a green "live" on a dead stream is the most misleading thing this
UI can render. The watchdog is skipped entirely when no `EventSource` object exists: a pane that
deliberately released its stream (`UNPIN_IDLE_MS`) is detached on purpose, not faulty.

> **The beat carries no session state, and that is load-bearing.** The first cut rode `busy` along as
> a free self-heal for a pane that missed a `result`. It loses a race it cannot win: `send()` sets
> `busy` optimistically on the client *before* its POST lands, so a beat crossing that ~1–2s cold-start
> window reads the not-yet-created server session as idle and blanks the indicator on the very turn
> the user just started. Caught before shipping. If a `busy` self-heal is ever wanted, it needs to
> know about the in-flight POST; the heartbeat does not.

### Gotchas
- **After a resync you hold two versions of the turn.** Prefer local blindly → lose what arrived
  during the outage. Prefer server blindly → roll back text the user already watched appear. The
  tiebreak is timing (`lastDeltaAtRef` vs the resync start), not a guess about which is fresher.
- `sentOnce` only flips true on a `snapshot` event — *proof* a live session exists — never
  optimistically on send. Until then every send carries `resume: <sessionId>`, so a lost connection
  can't silently start a fresh, context-less session.

---
