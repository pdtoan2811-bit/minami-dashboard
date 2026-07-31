# §15 — Teams

A **team** is a template's roles instantiated as standing agents. A **product** is a workspace, a team
and a record. A **run** is one task walking the team's chain, one stage at a time, all appending to one
document.

Sits on top of §14 the way §14 sits on top of §1 and §3: every stage is an ordinary assigned agent
task, and the only thing this layer adds is *order* and *a shared document*. Opt-in under the same
Settings → Agent view toggle (§15.6).

---

## 15.1 One task, N sessions, one document — not one chat with N folders

The decision everything else falls out of, and it's a rejection of the obvious design.

The obvious design is one conversation that pulls context from several folders as it goes. It fails in
a specific way: one context window ends up holding five roles' worth of half-remembered detail, every
role's instructions dilute every other role's, and no role does its own job well. It also can't be
resumed, reviewed per-stage, or re-run.

So instead:

```
run ──> stage 1 ──> stage 2 ──> stage 3 ──> …
         PM          Techlead    QA
         own home    workspace   workspace
         own memory  own memory  own memory
         own skills  own skills  own skills
              \          |          /
               \         |         /
                 ~/.minami/runs/<id>/dossier.md
```

Each stage is a **separate session in a separate folder** with its own persona, memory and skills. The
only thing that crosses the boundary between them is a markdown file on disk.

**Why a file rather than a payload.** A structured handoff object would have to be filled in by a model
anyway, and then nobody could read a run without this app. A markdown file is readable, correctable by
hand, greppable, and survives the dashboard being down. The cost — that "did the stage write anything"
becomes a real question — is paid explicitly in §15.4.

### Mechanics

- **Roles are global brains.** `~/brains/<role>`, one per role, shared by every product using that
  template. Instantiating the tech-product template twice finds the existing PM rather than making a
  second one, so craft compounds instead of being re-learned per project. Reuse is keyed on the **home
  folder**, which is the same key `agentAtHome()` guards uniqueness with (§14.2) — so this layer can't
  produce a state that route would refuse.
- **The role/product memory split.** What a role learns about *the craft* goes in its `MEMORY.md` and
  makes it better everywhere; what it learns about *one product* goes in the product record. Written
  into every role persona, because the failure mode without it is a single PM applying a Shopify app's
  constraints to a content brief.
- **Role brains are git repos** (`ensureBrainRepo`), and the runner commits after every stage. Agents
  may rewrite their own persona and skills after a run, so "the QA got worse last week" has to be
  answerable with a diff. `git init` is skipped if the folder is already inside a repo — an adopted
  brain under `~/secondBrain` would otherwise become a nested repository the outer repo sees as an
  opaque blob, silently, and only noticed when the vault's history has a hole in it.
- **The workspace whitelist is used as a real boundary.** `RoleSpec.needsWorkspace` decides who gets
  the repo added to their `workspaces` — Techlead and QA yes, Marketing and Sales no. `assign()`
  enforces it (§14.3), so this is the difference between a role that can touch the code and one that
  works from the dossier alone. A whitelist everyone is on describes nothing.

---

## 15.2 Templates are data; the engine knows no role names

`lib/teams/templates/*` — three shipped: `tech-product` (the default), `solo-founder`,
`content-studio`. A template is roles plus a **chain of stages**, and a stage is not the same thing as
a role:

```
RoleSpec  { key, name, icon, role, needsWorkspace, persona, skills[] }
StageSpec { key, role, section, instruction }
```

The chain has one entry per *step*, so a role can appear more than once. Every shipped template uses
that for the same structural reason:

> **Whoever sets the bar checks against it.** The PM writes the acceptance criteria at stage 1 and
> checks the run against *those criteria* at the last stage. Split those across two roles and the check
> silently degrades into "does this look finished", which always passes.

The other consequence of the interview that produced this design: filing the record is folded into
that closing stage rather than given to a separate Librarian. Cheaper — five roles, not six — and the
known cost is stated here so it can be recognised later: **no cross-product duplicate detection, and
filing quality varies with how long the run ran.** If the record starts drifting, pulling filing back
out into its own agent is additive (the record path already lives on the product), not a rewrite.

### Mechanics

- **Templates are TypeScript, not JSON on disk.** They're the thing that must be right before anything
  else works, so a broken one should fail `npm run build:check`, not a run at 2am.
- **`templateProblems()` runs at product creation, not at import.** A typo in one template's chain
  shouldn't take the whole dashboard down at boot — and the failure it would otherwise cause (a run
  dying three stages in with "agent undefined") is expensive at exactly the wrong moment.
- **`summarize()` is what crosses the wire.** Personas and skills are thousands of words each; the
  picker renders a name and a line. Sending whole templates would put ~40kB of prompt text into every
  poll.
- **Every role gets the `dossier` skill** (`templates/common.ts`). The coordination model is "everyone
  appends to one file", and that only holds if every role treats the file identically. Left to a
  prompt it drifts by the third stage: an agent that finds a section it disagrees with will rewrite
  it, and the reasoning that produced the disagreement goes with it. As a skill it also loads for
  sessions you start by hand in that folder.
- **Template personas are written, not TODO-laden** — the opposite of `scaffold.ts`'s default persona,
  and not a contradiction of it. That one is a blank a human fills in during the onboarding interview,
  because a generic agent has no defined job. "The QA of a tech product team" does. Shipping stubs
  would mean five interviews before the first run. `scaffold()` gained optional `persona` / `skills`
  for this, still write-if-absent — a second product pointed at the same brain must not revert a
  persona the agent has since improved.

---

## 15.3 Three places, three lifespans

| Where | What | Lifespan |
|---|---|---|
| `~/.minami/runs/<runId>/` | `run.json` + `dossier.md` | disposable working state |
| `<record>/` (default `~/secondBrain/10-19 Projects/<Name>/`) | `00-index.md`, `decisions/`, `specs/`, `uat/`, `log.md` | the durable, curated truth |
| `<workspace>/CLAUDE.md` | a marker-bounded team block | as long as the product exists |

**The dossier is the transcript; the record is the truth.** Runs are cheap, long and chronological;
the record is short, current, and organised so someone joining in six months reads it in ten minutes.
The closing stage's `filing-the-record` skill exists to enforce merge-don't-append, mark superseded
decisions rather than deleting them, and update the index *last*.

**Why the record defaults to the vault.** It's already the cross-project truth on this box: it syncs to
every device, Minami reads it from Slack, any Claude session anywhere can open it. A record only the
dashboard could see would be a fourth place to look.

**Why the repo block is in `CLAUDE.md` and not a tidier file.** `CLAUDE.md` is loaded automatically by
every Claude session whose cwd is that folder — a dashboard pane, a bare `claude` in a terminal,
Minami spawning a headless session from Slack. A team named there is inherited by all of them with no
dependency on this app running. Anywhere else and the knowledge stops at the dashboard's edge, which
is the folder-boundary problem the whole thing exists to solve. Bounded by markers so it rewrites in
place and removes cleanly; appended rather than inserted at the top, because the opening of a
`CLAUDE.md` is what a human wrote to be read first.

- **Syncing the record is off by default**, per product. An unattended run pushing to a synced vault is
  an outward action nobody watched happen. The closing stage's brief says so explicitly in both
  directions — with sync off it is told to write files and stop.
- **Deleting a product** removes the registry row and the repo block, and touches neither the record
  nor the brains. Same reasoning as deleting an agent (§14.1): the record is this product's
  accumulated understanding, and the brains belong to every other product too.

---

## 15.4 The runner: order, and the hole a stage can leave

`startRun()` dispatches and returns. `drive()` walks the chain in the background.

```
for each stage:
  assign(agent, { title, brief: stageBrief(...), cwd })   ← an ordinary agent task (§14.3)
  await the TASK RECORD reaching a terminal state
  check the stage's section actually appeared in the dossier
  commit the agent's brain
```

**Why each stage goes through `assign()`** rather than spawning directly: it buys the workspace check,
attribution in the History tab, the mechanical activity log, and the agent's wrap-up turn — four
things that would otherwise be rebuilt worse. A stage is just work assigned to an agent.

**Why it polls the task record.** Same reason §14.3 polls the manager: a subscriber counts as a
connected client and would suppress the manager's rescue of a session parked on a prompt nobody can
answer. One level further out, watching the task record has a second benefit — a task is only `done`
after its wrap-up has run, so the next stage starts against an agent whose memory is already current.

### Mechanics

- **`appended` is recorded per stage.** A stage can finish successfully having written nothing (the
  model summarised in chat instead), and every later stage then reads a document with a hole in it and
  no indication there was meant to be more. Checked with a deliberately loose heading match —
  case-insensitive, punctuation-tolerant — because the heading is copied by a model from a brief, and
  failing a stage over a smart quote is the kind of brittleness that makes people stop reading the
  status column. Surfaced on the rail, in `bin/team.mjs run-status`, and as a `_[runner]_` note in the
  dossier itself so the *next stage* knows.
- **Runner-written lines in the dossier are labelled `[runner]`.** The next stage reads that file as
  the record of what the team decided; an unlabelled machine line ("the QA stage failed") would be read
  as a peer's finding.
- **Everything checkable is checked in `startRun()`**, not in `drive()`: a missing agent or a broken
  template found three stages in has already cost twenty minutes and half a dossier.
- **The stop check is re-read from the run record every iteration.** Stop is on screen for the whole
  run, and the record is the only thing that knows a human ended it — the identical omission in the
  agent runner reported a stopped run as a success (§14.3).
- **Two ceilings, neither of them the stage's.** `MAX_RUN_MS` (3h, `MINAMI_TEAM_RUN_TIMEOUT_MS`) is the
  backstop for a chain of individually-legal stages; each stage still has the agent runner's own
  30-minute limit. `MAX_STAGES` (12) **refuses** rather than truncates — silently running the first
  twelve stages of a fifteen-stage template produces a run that looks complete and isn't.
- **Orphan reaping at import**, exactly as §14.3: every stage is a live session, live sessions are
  children of this server, and a deploy restarts it. A run still `running` from a dead process has no
  driver and never will. Keyed on `pid`, not on module-load timing — smoke-testing this subsystem is
  what surfaced the post-mortem in §14.3, where the two were conflated and a live run was reaped
  mid-chain.
- **Run listing is bounded.** The Teams view polls; reading every `run.json` on every tick grows
  without limit. `listRuns()` stats the directories (cheap), takes the newest 40, parses only those.

---

## 15.5 The stage brief

Everything positional is spelled out: the absolute dossier path, the exact heading to write, who ran
before, who runs next, where the workspace and record are. The agent receiving it has never seen this
run — its own memory, its own folder, and no access to the conversation that started any of it.
Anything implied is lost.

It does *not* repeat "you are unattended, you cannot ask questions": `taskPrompt()` (§14.2) already
wraps every assigned task with that, and the `dossier` skill says it again in the role's own folder.

---

## 15.6 The view, and the mode

`/teams` (products + recent runs) → `/teams/<id>` (team, record, runs) → `/teams/run/<runId>` (stage
rail + the dossier rendered).

- **The dossier is the page.** Everything else is navigation around it. A UI that summarised the
  dossier would be a second, worse account of a document already meant to be read.
- **The run page polls only while the run is live.** A finished run is a static file; re-fetching it
  every 4s on every tab left open on last week's run is pure waste.
- **Both nav entries sit behind Agent view.** Teams is built *on* the agent layer — a product's roles
  are agents — so showing Teams while Agents is hidden would offer a view whose every link leads
  somewhere hidden. `localStorage`, client-only: runs already in flight keep going with it off, and
  the server's registry doesn't care what one browser shows.
- **The team list links out to `/agents/<id>`** rather than reimplementing an agent view. A role *is*
  an agent, shared with every other product using it, and a second home for it here would invite
  editing it somewhere that doesn't know that.

---

## 15.7 Files

| Path | Holds |
|---|---|
| `lib/teams/types.ts` | `TeamTemplate`, `RoleSpec`, `StageSpec`, `Product`, `TeamRun`, `RunStage` |
| `lib/teams/templates/*` | the three templates, the shared `dossier` skill, the persona builder |
| `lib/teams/store.ts` | product registry, `createProduct()`, record path defaults |
| `lib/teams/brains.ts` | role→agent resolution, workspace grants, brain git repos |
| `lib/teams/dossier.ts` | dossier paths, header, system notes, section detection |
| `lib/teams/runs.ts` | run records, bounded listing, orphan reaping |
| `lib/teams/run.ts` | `startRun()`, the chain driver, `stopRun()` |
| `lib/teams/repo-hook.ts` | the marker-bounded team block in a workspace's `CLAUDE.md` |
| `lib/teams/client.ts` | browser-side types and fetchers (imports no server module) |
| `app/api/teams/**` | products · runs |
| `app/teams/**` | products page, product page, run page |
| `components/teams/*` | new product, new run, stage rail |
| `bin/team.mjs` | the CLI the repo block names |
