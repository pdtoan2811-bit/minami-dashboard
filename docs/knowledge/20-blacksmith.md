# Blacksmith — the chat pane as the agent factory's operator console

Index: [`../KNOWLEDGE.md`](../KNOWLEDGE.md) · Related: [§3 live sessions](03-live-sessions.md) ·
[§14 agents](14-agents.md) · [§15 teams](15-teams.md)

---

## 20. Blacksmith (2026-09-14)

[Blacksmith](https://github.com/juzser/blacksmith) is a **separate project** — an autonomous agent
factory at `~/dev/blacksmith`, CLI `smith`. You co-plan a spec, it decomposes the work, each task runs
in its own git worktree under a token budget over paths no other worker may touch, and what merges is
decided by gates: schema, tests, a reviewer that never saw the coder's session, and a verifier whose
only job is to refute the reviewer.

This section is **only** about the dashboard's side of that: a chat mode, a read-only panel, a tile
badge. Nothing here orchestrates anything.

### 20.1 What was asked, and the diagnosis underneath it

The ask was two things: a mode to enable Blacksmith in the chat panel, and better UI for seeing an
agent work — *"I often got confused and wondering if the blacksmith still running or not."*

The second half turned out to be **three different questions wearing one indicator**:

| Question | Who can answer it | State before |
|---|---|---|
| Is the chat session driving the factory still working? | the dashboard's own `s.busy` / activity | a phase clock that reset every couple of seconds — see §4 |
| Is this pane still *connected* to the server? | the SSE stream | nothing — a dead stream and a working pane rendered identically (§5) |
| Is the **factory** progressing? | Blacksmith's event log | not surfaced at all |

The first two are general defects and were fixed dashboard-wide (§4 two clocks, §5 the heartbeat).
Only the third is Blacksmith-specific, and it is the rest of this section.

### 20.2 The load-bearing fact: Blacksmith cannot tell you it is running

**There is no `session-ended` event.** Blacksmith's own UI reports `lastEventAt` as *evidence* and
leaves the judging to the caller. So there is no honest boolean for "is the factory running", and this
integration does not invent one — the panel reports the **age of the last event** and says
`moving` / `quiet · 7m ago`. That wording is the feature. "Stopped" would be a claim nobody can make.

It is also not a fault when it is quiet. Blacksmith has no scheduler and **no dispatch driver**:
`smith daemon` watches and reports but "never dispatches, never merges and never writes to a
worktree". The factory only moves when an operator moves it, so long quiet periods are the normal
state and must not read as an alarm.

The corollary bites harder, and it is why `staleAgents` exists. `liveAgentCount` counts
`dispatch_decision` events that never received a terminal event. In a hand-driven factory — every
coder and reviewer spawned by hand, every `smith judge report` typed by hand — **a forgotten report
leaves a phantom "live agent" on the board forever**. A count that only ever goes up is worse than no
count, so any dispatch older than `STALE_AGENT_MS` (90 min) is separated out and labelled. That
threshold is sized off the factory's own evidence: the longest measured coder turn in the first
external epic was ~247k tokens, well under an hour of wall-clock.

### 20.3 Why HTTP, and not the database or the log

`smith ui serve` binds `127.0.0.1:4680` (local-first, no auth) and exposes `/api/pulse`,
`/api/overview`, `/api/kanban`, `/api/tasks/:id`. **It re-projects changed sessions on every request**,
fingerprinting each `state/events/*.jsonl` by size+mtime. That makes polling it cheap, always current,
and incapable of writing anything.

The two alternatives were both worse:

- **`state/smith.db` directly** — it is a *derived* read-model that only exists because something ran
  the projector. Nothing projects on a schedule (the daemon would, but `state/daemon/` has never
  existed on this box), so it can be arbitrarily stale. It also runs in WAL mode, so a naive reader
  silently misses everything still in the write-ahead log.
- **Tailing the event log** — the most faithful source and the most code: hash-chained JSONL with
  `event_id` derived as `<session_id>#<lineIndex>`, which would mean reimplementing the projector.

`/api/pulse` is fetched first and alone, because it is the cheap column-projected probe that never
loads event payloads — a factory that isn't serving costs one failed connect rather than four. The
other two are best-effort and fetched together: a shape change in one of Blacksmith's endpoints should
degrade that section, not blank the panel that tells you the factory is alive.

**Read-only by construction, and it stays that way.** Everything Blacksmith admits has to pass its
gates, and a dashboard button is not a gate. The factory refused three operator shortcuts in its first
external epic, each correctly; a UI that could route around that would be removing the product.

### 20.4 The mode

Third member of the `setModel` / `setFanout` family, identical mechanics — see §3 for the
creation-only trap and the teardown-and-resume contract that answers it. The pieces:

`BLACKSMITH_PROMPT` + `DEFAULT_BLACKSMITH` (manager.ts) · `Session.blacksmith` · the
`systemPrompt.append` conditional · `setBlacksmith()` · `POST /api/agent/blacksmith` ·
`changeBlacksmith()` (use-agent.ts) · the `⚒ smith` pill in `ModeControls` · `chatBlacksmith:<key>`.

**Why a mode and not a skill.** Blacksmith ships its own `/bs` skill, which states outright that it
"never calls an LLM directly and never embeds a role prompt" — the judgment steps are separate Claude
Code sessions the operator dispatches from `.claude/agents/<role>.md`. So the session has to know it
IS the dispatcher, and a skill that loads when the model decides it's relevant cannot establish that.

What the prompt carries, and why each part earned its place:

- **The dispatch contract** — five things every spawned agent must be handed explicitly: task spec,
  ABSOLUTE worktree path, path claims, token cap, turn budget. The last is named because the role
  templates carry a `maxTurns` key *Claude Code does not read*; the number is only true if the prompt
  says it.
- **That the factory's refusals are correct** and must not be worked around.
- **Two standing hazards**, both learned expensively: a git worktree is a checkout, not an environment
  (ask what a check *transitively* touches, not what language it's written in); and a fix that ADDS a
  condition is often the next round's bug — three consecutive rounds on two components each repaired a
  real defect and introduced a fresh one, converging only on "delete the thing you added last round".
- **Never hand-estimate a number you are about to assert.** An operator's arithmetic once turned four
  under-budget tasks into a reported 13–44% overrun; `smith gate run`'s token count must be measured
  off the transcript.

Off by default (`MINAMI_DASHBOARD_BLACKSMITH=1` flips it): the prompt is long and names a clone most
installs don't have. And unlike fan-out it does **not** seed a global default from the per-pane
choice — see §3 for why.

### 20.5 What the panel and the badge show

`lib/blacksmith/client.ts` normalizes; `lib/blacksmith/use-blacksmith.ts` is one refcounted poller for
the whole page (5s live, **30s when the factory is down** — most installs have no Blacksmith, and a
dashboard firing a doomed request every five seconds forever is a bug even if nothing notices). A
per-component `useEffect` fetch would have meant one request per bento tile per tick for one identical
answer, each making `smith ui serve` re-project the log.

Panel headline: `⚒ Blacksmith · moving|quiet · <age> · <epics in flight> · N stale · N blocking`.
Expanded: task-status histogram, open findings by severity, per-epic token spend against budget, and
**per-session event age** — which is where "*which* epic has gone quiet" gets answered, something the
single headline age deliberately does not try to do.

Blacksmith's own closed vocabulary is passed through, not re-labelled: `todo · ready · in-progress ·
grading · reviewing · merging · blocked · completed · waived · failed · escalated · superseded` for
tasks, `S1-stop-the-line … S4-nit` for severity. Renaming any of it would make the panel and the CLI
disagree about the same record.

The **tile badge** (`⚒ 12/30 · 2 blocking`) renders only on a tile whose folder Blacksmith is actually
building — matched on folder **basename**, not path. Blacksmith anchors every file it writes to its own
clone and records the target only as a bare `project` string, so the checkout it is building can live
anywhere on disk; there is no path to compare against.

`/api/blacksmith` always returns **200, even when the factory is down** — `up: false` plus a reason is
the answer, not an error. Half the point of the panel is to say "Blacksmith isn't running" clearly
instead of rendering an empty board, which reads exactly like "Blacksmith is running with nothing to
do".

### 20.5b Whether the mode is in effect (2026-09-17)

> 🐛 **The mode described a factory the session could not reach.** `/bs` and the fourteen role
> templates are **project-level** files in the clone's `.claude/` — the skill's own header says
> "from a Claude Code session inside this repo". A pane in any other folder (the normal case: you
> flip ⚒ on the *project's* tile, not on the factory's) got a prompt naming a skill and agent types
> that did not exist in its session, and `smith` is not linked on this box, so the skill's relative
> `node factory/orchestrator/dist/cli.js` fallback failed from every folder that wasn't the clone.
> The pill lit, the strip polled, the model improvised or shrugged. Nothing measured any of it: the
> pill read localStorage, `init` didn't carry `blacksmith`, and no one counted whether a turn ever
> touched the factory. Three fixes, each a measurement rather than a belief.

**1. Bring the factory to the session.** MEASURED with a prompt-less SDK probe (`supportedCommands()`
/ `initializationResult()` on a streaming-input query that never sends a turn):

| Option | `/bs` visible | roles visible | clone's hooks/settings |
|---|---|---|---|
| baseline, cwd `/tmp` | no | no | — |
| `additionalDirectories: [clone]` | **yes** | **all 14** | **no** (PreToolUse guard did not fire on a Haiku turn) |
| `plugins: [{path: clone/.claude}]` | no | no | — |

So a Blacksmith session is spawned with `additionalDirectories: [BLACKSMITH_HOME]`, and the SDK's own
`init` message (`slash_commands`, `agents`) is checked afterwards — preflight says the files exist,
`init` says they arrived. `smith` reaches PATH through a three-line shim under `os.tmpdir()` (each
Bash call is a fresh shell, so only the subprocess environment survives across calls). The clone's
PreToolUse guard hook does **not** follow — the briefing names `factory/policies/guardrails.yml`
so the model holds to the rules itself; the gates downstream still check the result.

**2. Tell the model what was measured.** `blacksmithBriefing()` is `repoBriefing()`'s pattern for
the factory: the absolute CLI, the loaded roles, and — the answer the skill says to ask for once —
that `<project-dir>` is the pane's own cwd (`--project <cwd>`), unless the pane *is* the clone. When
preflight fails the briefing says so and forbids improvising a substitute (no hand-rolled worktrees,
no untracked agent spawns).

**3. Show the pane what its session has.** `init` now carries `blacksmith`/`fanout` (what the session
was *born* with); the ⚒ pill renders the model picker's `•` staged dot when the pick and the session
disagree, and goes amber `⚠` when the session has the mode and the server measured it can't work.
A `smith` SSE event (REPLACE semantics, replayed on attach) carries `SmithEvidence`: `ready`/`issue`
from preflight + init, `touches` (a `smith` command, `/bs`, a role dispatch, a read or write inside
the clone), `agents` (the dispatches), `lastAt`, and `blindTurn` — the last completed turn ran
Bash/Edit/Write/Agent at the top level and none of it reached the factory. The strip's second row
("this pane · …") renders whichever is worst: not in effect → blind turn → staged → in effect with
counts. It renders whether or not `:4680` answers, because "the factory is down" and "this session
never got the contract" are independent facts, and the strip mounts on `picked || born` so a pane
attached to an operator session another pane started still shows it.

Verified 2026-09-17 on the iterate build from `/tmp/bs-probe-project` (not the clone): `init` carried
`blacksmith:true`, `init.agents` confirmed all 14 roles, `smith --help` returned real usage through
the shim, the model confirmed `/bs` and `coder` available, `touches` counted the call, a Write-only
turn flipped `blindTurn:true`, and the strip rendered the staged row and then the in-effect row after
the pill was clicked into agreement.

(Verified through `send()`, not attach — under `next dev` a pane never attaches on mount, the
StrictMode trap already recorded in §5e. It cost this probe twenty minutes anyway.)

### 20.5c Fan-out is subordinate, not additive (2026-09-17)

> 🐛 **Fan-out was overriding the factory.** Both modes are instructions about how to spawn agents,
> and both were appended when both pills were on — fan-out first, and fan-out is ON by default. So
> the typical operator session read *"independently workable parts → Agent tool, in parallel, don't
> ask"* before it read the dispatch contract. The generic instruction is broader and earlier, so a
> coder's job got answered with ad-hoc `general-purpose` agents — the one dispatch the gates cannot
> see, and a `blindTurn` by construction with the ⑂ pill lit as the reason.

Three changes. The server never appends `FANOUT_PROMPT` to a Blacksmith session (`s.fanout && !pre`);
`setFanout()` on such a session records the pick without a respawn (the prompt would be identical);
and `BLACKSMITH_PROMPT` gains a paragraph saying what parallelism means there — a wave of role
dispatches under the contract, in parallel when path claims are disjoint, never an ad-hoc fan-out,
with one exception for pure reading (no files, no artifact → not a task). The ⑂ pill renders
`⑂ via smith`, dashed and muted, still clickable, with the reason in the title; the pick survives
and returns on the respawn that turns ⚒ off.

### 20.5d Starting the factory UI from the strip (2026-09-17)

The down state used to read *"not reachable — start it with `smith ui serve`"*: an instruction to a
person sitting in a browser with no terminal in reach, in the one moment the strip mattered. Now it
is a button. `POST /api/blacksmith/serve` → `serveBlacksmithUi()` spawns `node <CLI> ui serve --port
<n>` **detached and unref'd from the clone** (its defaults — `state/smith.db`, `factory/specs/
roadmap.md` — are relative paths), stdio to `<tmpdir>/minami-blacksmith-ui.log`, then waits up to 8s
for **the pulse, not the pid** — a listening server is the fact the strip needs, an exited process
is the fact the operator needs (`ui.not-built` exits in under a second and is named). Refused when
already up: a second server on one port crashes, and a crash log reads like "won't start". The port
comes from `MINAMI_BLACKSMITH_URL`; a non-loopback host is refused, because it isn't something this
box can start. Takes no input — binary, clone and port are the server's own config, so there is
nothing to point it at.

Still not a writer. `smith ui serve` is the read-only projector the whole panel already depends on;
starting it changes whether the strip can *see*, not what the factory holds. The header comment in
`BlacksmithPanel.tsx` says so, because "everything here is read-only" is a claim the next person
will check against a button labelled `start`.

The hook gained `refreshBlacksmith()` (poll now, ignoring the 30s down-backoff — without it the strip
kept saying "not reachable" for up to half a minute over a server that was already answering) and
`startBlacksmith()`. When up, the headline carries an `open ↗` link — it was only in the expander's
footer before, which is not where you look for a door.

Verified 2026-09-17: down → `start` → `up: true` in 1.8s (route) / ~2s (strip), pid detached and
surviving the iterate server's exit; the `oe-central-ver2` tile badge came back with it.

### 20.6 Verified

2026-09-14, against the live factory on `:4680` with three epics in flight
(`central-customer-360`, `central-real-screens`, `central-retire-filament`):

- `/api/blacksmith` returned real state — 487 events, tasks `12 completed / 1 in-progress / 4 ready /
  13 todo`, findings `2×S2 · 2×S3 · 1×S4`, `central-real-screens` at 510k of its 550k budget.
- The panel rendered headline + expanded detail in a pane with the ⚒ pill lit.
- The tile badge appeared on `oe-central-ver2` and on no other tile.
- The SSE heartbeat: 3 beats in 36s at 9–10s intervals.

**Not exercised live:** the turn clock and the stale-link indicator under a real in-flight turn — both
are typechecked and built, and the heartbeat they depend on is verified, but no dashboard turn was run
to watch them count. Worth confirming on the first real turn after deploy.

### 20.7 The obvious next thing, and why it is not here

Blacksmith's biggest open build is the **dispatch driver** — step 6 of the per-task chain, the one the
operator performs by hand. Everything around it already exists and already emits JSON: `wave check` →
`worktree create` → `lessons/findings for-dispatch` → **[spawn the agent]** → `judge dispatch` →
`judge report` → `gate run` → `queue run`.

The dashboard is unusually well-placed to close it: `assign()` (§14.3) already spawns a session in a
given folder under a given model and permission mode, `taskKey()` already namespaces a session so the
read pipeline attributes it back, and the manager already measures real token usage — which is exactly
the number an operator currently types by hand into `smith gate run` and once got wrong by 44%.

It is deliberately out of scope here. It is a large piece of work, it belongs as much to Blacksmith as
to this dashboard, and it would make this integration a writer rather than a reader — which changes
the security posture of every paragraph above. Recorded so the next person starts from the map rather
than the discovery.
