# §14 — Agents

Standing agents: a named worker with its own home folder, memory, model and permission level, that you
chat with, assign unattended work to, and chain to other agents. Opt-in — Settings → Agents → Agent
view — and additive: with it off, nothing about the session board changes.

Where the board answers *what is running, and where*, the roster answers *who is doing it*.

---

## 14.1 An agent is an identity plus a home folder — not a cwd

The single decision the rest of the subsystem falls out of.

```
AgentDef {
  id, name, role, icon              identity
  home                              its brain: persona, notes, memory. Stable for life.
  workspaces[]                      folders it may be assigned work in
  model, permissionMode             how it spawns
  hq                                the one you talk to (unique)
}
```

`home` is where it thinks and remembers. `workspaces` are repos you let it go and work in. **A run in
a workspace still writes what it learned back to `home`.**

The obvious simplification is agent == cwd, and it's wrong. An agent that forgets everything the
moment it steps into `~/ecomIntel` is a chat window with a name on it — the memory has to follow the
identity, not the working directory. Everything awkward in this subsystem (attribution, the write-back
turn, the workspace whitelist) is the cost of that split, and it's the whole value.

### Mechanics

- **Two stores.** `~/.minami/agents/<id>.json` is the registry the *server* enumerates; the home
  folder holds the substance. On disk rather than `localStorage` for the same reason as
  `lib/autopilot/config.ts` (§13): a task runner spawning a session needs cwd, model and permission
  mode with no browser to ask, and must still know them after the restart a deploy causes.
- **One file per agent**, not one array — several panes can create agents at once, and separate files
  make that safe without a lock.
- **`normalize()` coerces on every read.** These files are meant to be hand-edited; a junk field
  degrades to a default rather than reaching `query({ cwd: undefined })` and failing somewhere far
  from the cause.
- **Exactly one HQ.** Promoting one demotes the rest, in the store, so two tiles can't both claim to
  be the front door.
- **Deleting an agent never touches its folder.** That folder is months of notes; a roster tidy-up
  must not be able to destroy it. Removal is reversible by re-adopting the path.

### Gotchas

- `model` is honoured **only at session creation** (`ensureSession`). A warm session keeps the model
  it was born with — same caveat `lib/model-pins.ts` states about account switching. The config form
  says so; without that, "I changed the model and it kept using the old one" reads as a bug.
- Model ids live in `lib/model-catalog.ts`, re-exported from `lib/model-pins.ts`. The catalog is a
  separate leaf module *only* because `model-pins.ts` reads `~/Minami` off disk and the picker runs in
  the browser. Don't inline a model id in a component — that's the drift `model-pins.ts` exists to
  prevent.

> 🐛 **An agent's history was empty for work it had definitely just done.** A task ran in
> `/tmp/agent-home-test`, wrote its file, and reported success — and the History tab showed nothing.
> The CLI records the **resolved** cwd in its transcript, and `lib/claude-sessions.ts` finds a
> session's folder by encoding that path; the registry had stored the path as typed. On macOS `/tmp`
> is a symlink to `/private/tmp`, so the two encoded to different directories and the lookup landed in
> a folder that didn't exist. Fixed by resolving through `fs.realpathSync` in the store's
> `normalize()` — on every **read**, not just at creation, because a folder that doesn't exist yet
> (an agent created moments before its home is scaffolded) can't be resolved. `assign()` resolves the
> incoming cwd too, or the workspace check would refuse `/tmp/x` against a stored `/private/tmp/x`.
> The failure is silent and total: no error, just an agent that appears to have never done anything.

---

## 14.2 Creating one: scaffold or adopt, and the interview that fills it

Two paths in, one shape out. **Scaffold** writes a fresh brain. **Adopt** points at a folder that
already has one — `~/secondBrain` is the case this was built for — and fills only what's missing.

```
home/
  CLAUDE.md              persona: what it owns, what it never does, voice, how it maintains this folder
  MEMORY.md              durable facts and the why behind decisions
  00-09 System/activity.md   append-only run log
  10-19 Projects/  50-59 Sources/.raw/  60-69 Wiki/
  .claude/skills/        procedures that load for any session in this folder
  .claude/settings.json  the enforceable half of its tool permissions
```

### Mechanics

- **Nothing is ever overwritten.** `inspect()` reports what a folder already has; `scaffold()` writes
  only absent pieces through `writeIfAbsent()`. The folders most worth adopting are the ones with
  years of curation in them, and a create flow that can clobber one is a create flow nobody points at
  anything real.
- **Registry entry and folder are written in one request.** An agent whose home doesn't exist is a row
  that fails the moment anyone talks to it; splitting the two leaves one orphaned on every failure.
- **The dialog inspects as you type** (`/api/agents/inspect`), so "adopting a folder with 33 past
  sessions" is visible *before* you commit, not reported after.
- **Adoption inherits history immediately** — every transcript already in that folder becomes the
  agent's. That is the point of offering adoption at all.
- **The interview is a real session, not a form.** `POST /api/agents/:id/onboard` sends
  `onboardingPrompt()` into the agent's own chat key, so the questions arrive as `AskCard` chips
  (§5e) and the agent writes its own persona, notes and permissions from your answers. A form would
  capture the same fields and produce a persona nobody wrote.
- The scaffolded `CLAUDE.md` is deliberately **full of TODOs**. A template of confident placeholder
  prose reads as finished and never gets filled in; holes invite the interview that closes them. The
  roster and the detail header both nag until `onboardedAt` is set.

### Gotchas

- `onboardedAt` is stamped **on dispatch**, not on completion. There's no reliable signal for "the
  interview finished" — it's a conversation that can trail off and be resumed — and the flag's only
  job is to stop the nag.
- Promoting an agent to HQ **appends to its `CLAUDE.md`** (`ensureHQSection`). Intended: an agent
  that's HQ on the roster but was never told how to delegate will just do everything itself. Worth
  knowing before promoting an agent whose home is a vault you keep in git.

---

## 14.3 Assigned tasks: the runner, and why it polls instead of subscribing

`assign()` dispatches and returns. The run outlives the request, the tab, and whatever turn asked for
it — a task is minutes of work, and the endpoint is one HQ calls from inside its own turn.

```
assign → sendMessage(key=agent:<id>:<taskId>, cwd, model, mode)
       → drive():  awaitTurn → harvest result → wrap-up turn → activity log → handoff
```

### Mechanics

- **The runner never subscribes.** `manager.ts` exports `subscribe()`, and using it here would be a
  bug: a subscriber counts as a connected client, and `scheduleIdle`'s rescue path is gated on
  `subs.size === 0` (§3). An unattended run has by definition nobody to answer a prompt — so a
  server-side subscriber would suppress the exact backstop that stops a parked run pinning `busy`
  true forever. And a pinned `busy` starves **every deploy on the box** (§8), not just this task. So
  the runner stays outside and polls `isBusy()` / `liveActivity()`, which observe without
  participating.
- **Three ways a run ends badly, each with its own guard:** never spawned (`SPAWN_GRACE_MS`, 90s),
  ran too long (`MAX_RUN_MS`, 30 min), or stalled at `phase=awaiting` (`AWAIT_LIMIT_MS`, 3 min). The
  manager's own backstop covers the third too, but only after `IDLE_REAP_MS` — half an hour of `busy`
  no deploy can get past.
- **The brief tells the agent it cannot ask questions.** Cheaper than any guard: it states an
  assumption and proceeds instead of stalling behind a question nobody will answer.
- **The workspace whitelist is enforced in `assign()`.** A list that isn't enforced is decoration.
- **Orphan reaping at import.** Live sessions are children of this server, so a restart killed them;
  anything left `running` from a previous process is a lie and is closed as failed on load.

### The write-back — two halves, deliberately

| Half | Who writes it | Why it exists |
|---|---|---|
| Mechanical | the runner, in `logActivity()` | Appends one line to `00-09 System/activity.md`. Runs whatever the model did or didn't do — an activity log with holes can't answer "what has this agent been doing". |
| Semantic | the agent, in a second turn | Only the agent knows what it *learned* and where it belongs. `wrapUpPrompt()` names the absolute paths, because the work happened in a workspace and the memory belongs at home. |

The wrap-up is **its own turn**, not a tail on the brief: a brief ending "and also write your memory"
gets treated as one task with a tail, and the tail is what gets dropped when the real work runs long.
As its own turn it either happens or visibly doesn't. **Failing it does not fail the task** — the work
is done and recorded, and marking a successful run failed because its memory note didn't land would be
actively misleading.

Verified 2026-07-30: the wrap-up correctly wrote *nothing* to `MEMORY.md` for a trivial task and said
so, which is what the prompt asks for ("an honest empty is better than padding").

### Handoffs

`handoffTo` chains a second agent onto the first's result, and the chain fires **after** the
write-back — so the next agent starts against an agent whose memory is current. A missing target is
rejected at assign time, not at handoff time: a chain that silently drops its second half looks
exactly like a chain that ran, and the discovery is half an hour later.

---

## 14.4 Attribution: what an agent may claim as its own

Two sources, and the difference between them is a claim about ownership.

| Source | Rule | Why |
|---|---|---|
| **Home** | every transcript in the agent's home folder is its own | Adoption is only worth offering if it hands over real history. |
| **Workspace** | only sessions a task record ties to it | A shared repo like `~/minami-dashboard` has transcripts from every pane on the box. Claiming all of them because one agent has access would be a fabrication — and a convincing one. |

The History tab badges each row `home` or `task` so this is visible rather than implied.

`listSessionsIn(cwds, limit)` in `lib/claude-sessions.ts` backs this — deliberately **not**
`listSessions()` with a filter. That one windows to the ~150 most recently touched transcripts box-wide
and cuts to 60, which is right for painting the grid and wrong for "everything this agent has ever
done": an agent whose folder went quiet for a fortnight would show an empty history while its
transcripts sat untouched on disk.

> ⚠ `AgentSession` names the joined task `run`, not `task`. `SessionMeta` already has a
> `task?: string` (the bento's Project > Goal > Task label); intersecting the two under one name
> collapses the field to `never` and every read of it silently stops type-checking.

---

## 14.5 HQ and the CLI

HQ is the tile you talk to. It orchestrates through **the same local API the dashboard uses**, driven
by `bin/agent.mjs` — so "agents hand off to each other" is a tool HQ holds, not a hidden code path
here. Its scaffolded `CLAUDE.md` carries the commands, because an agent told it *can* delegate but not
*how* will just do the work itself.

```bash
node ~/minami-dashboard/bin/agent.mjs list
node ~/minami-dashboard/bin/agent.mjs assign <id> "brief" [--cwd path] [--handoff <id>]
node ~/minami-dashboard/bin/agent.mjs tasks [<agent-id>]
node ~/minami-dashboard/bin/agent.mjs task <task-id>
node ~/minami-dashboard/bin/agent.mjs stop <task-id>
```

A thin wrapper and nothing more: the server owns spawning, the workspace check and the task records,
so a CLI that reimplemented any of it would be a second source of truth that drifts. It exists because
HQ is a Claude session with a Bash tool, and `agent.mjs assign researcher "…"` is something a model
gets right first time where a hand-written curl body is something it gets right most of the time.

---

## 14.6 The view

Reuses the shell rather than inventing one: bento tiles for the roster, `PanelTabs` (§5b, §5g) for the
detail view, `useAgent` (§3) for the chat, `FolderPicker` (§5d) for home and workspaces, `AskCard`
(§5e) for the interview.

- **HQ gets a wide card with a live chat in it** on the roster — one place you talk to, which routes
  work to everyone else.
- **The chat tab stays mounted** across tab switches (hidden, not unmounted). Remounting tears down
  the SSE stream and replays the whole transcript on every switch.
- **Live state is server-owned**, polled from `/api/agents` on the same 4s cadence as the grid —
  REPLACE semantics, never derived client-side, so the header can't claim an activity state nothing
  is in.
- **A ring only while genuinely busy.** "Live but idle" is a warm subprocess, not activity, and a
  permanently-lit tile teaches you to stop reading the light.
- The Settings toggle is `localStorage` (`bento:agentMode`) and hides the nav entry only. Agents on
  the roster keep working with it off — the server's roster doesn't care what one browser shows.

---

## 14.7 Files

| Path | Holds |
|---|---|
| `lib/agents/types.ts` | `AgentDef`, `AgentTask` |
| `lib/agents/store.ts` | registry read/write, HQ uniqueness, path resolution, `allowedCwds` |
| `lib/agents/scaffold.ts` | `inspect()`, `scaffold()`, the persona/memory/activity templates, `ensureHQSection` |
| `lib/agents/onboard.ts` | the interview, the task brief wrapper, the wrap-up prompt |
| `lib/agents/tasks.ts` | task records, atomic write, `sessionOwners`, orphan reaping |
| `lib/agents/runner.ts` | `assign()`, the poll loop, write-back, handoff |
| `lib/agents/history.ts` | attribution — home vs task |
| `lib/agents/client.ts` | browser-side types and fetchers (imports no server module) |
| `lib/model-catalog.ts` | the model menu, re-exported from `model-pins.ts` |
| `app/api/agents/**` | roster · create · patch · delete · inspect · onboard · tasks |
| `app/agents/**` | roster page, detail page |
| `components/agents/*` | tile, chat, config, history, tasks, create dialog |
| `bin/agent.mjs` | the CLI HQ delegates with |
