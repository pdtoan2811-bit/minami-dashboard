# Repo freshness — the checkout briefing

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 19. Repo freshness — `lib/repo-state.ts`

What branch a session's checkout is **actually** on, and how far it has fallen behind the line that is
really moving — measured by the server, with a fetch, and handed to the model as fact before its first
token.

Read-only apart from an ordinary `git fetch`. Nothing here decides anything: it produces measurements,
one system-prompt stanza, and one human-facing line.

> 🐛 **Five and a half hours of work on a dead branch, and the session argued the user out of noticing
> (2026-09-07).** Transcript `~/.claude/projects/-Users-thomas-secondBrain/e3607727-…jsonl` — cwd
> `~/secondBrain`, Opus 5, 5h30m.
>
> A session migrated a design kit into an ecvision homepage and previewed it all afternoon. Thomas:
> *"feel weird that the home changed - audit my code since the last time I push to git, it's a
> different homepage"*, then *"I think there is a problem with those worktrees, since I have just
> updated a new homepage to ecvision and it's on github already, but you keep spitting out the
> outdated version."* The session had **already** told him — in a confident forensic write-up — that
> his last push was `2b0b513` dated 2026-08-13 with 25 unpushed commits on top, and offered him an
> `AskUserQuestion` whose options included *"Nothing — the homepage is correct, I misremembered"*. He
> was right. It talked him out of it twice before he insisted.
>
> Two root causes, both one command away:
>
> 1. **It read `origin/main` without ever running `git fetch`.** A remote-tracking ref is a local
>    **cache**; it moves when you fetch and at no other time. Every number in that write-up described
>    the world as of three weeks earlier.
> 2. **It never asked which branch the checkout was on.** `~/ecvision` sat on
>    `feature/ads-reads-and-capture-import`, 237 commits behind `origin/develop`, never merged.
>    `main` was a **decoy** that hadn't advanced since Aug 13; `develop` was the trunk and had moved
>    that morning. All five hours landed on the dead branch.
>
> Its own words afterwards: *"I told you to keep a homepage from a dead branch, and framed your
> suspicion as misremembering. You were right and I talked you out of it."*

### Why this is a server measurement and not a prompt

The obvious fix — "remind the model to run `git fetch`" — is the wrong shape. A prompt that says *be
careful* loses to a working tree that renders and a `git log` that looks busy. The session had every
reason to believe what it saw; it wasn't being careless, it was being confidently wrong about a cache
it had no reason to suspect.

So this is the move the codebase has now made three times: **the server measures, and the model is
told.** `canUseTool` enforces permission modes rather than trusting the SDK to (§3). `maybeAutoCompact()`
made the server the auto-compact enforcer rather than trusting the SDK's own (§3). Here the server runs
the fetch and hands over the answer, rather than trusting a session to go and ask.

That also fixes the index's [recurring pattern](../KNOWLEDGE.md#the-pattern-behind-the-incidents) in its
newest clothes: a remote-tracking ref is one more signal that *looks* authoritative and is only a
claim — a snapshot with no expiry stamped on it.

### What it measures

`repoState(cwd)` → `RepoState`: root, `branch` (**null when detached**, never the literal string
`HEAD`), head sha, `dirty` file count, whether this is a linked worktree, `upstream`, `origin/HEAD`,
`fetchedAt` (FETCH_HEAD's mtime) and `stale`.

The part that matters is `candidates` — **every trunk-shaped remote branch that actually exists, with
its tip date, sorted newest-first.** `TRUNK_CANDIDATES` is `develop · main · master · trunk`, plus
whatever `origin/HEAD` points at.

- **`moving`** is the newest tip: the branch that is genuinely being worked on. That single field is
  what distinguishes a live trunk from a decoy, and it is the fact the 5.5-hour session never learned.
  Asking whether `main` *exists* answers nothing; asking when it last **moved** answers everything.
- **`behind` / `ahead`** come from `rev-list --left-right --count moving...HEAD` — one command, both
  numbers, no chance of the two disagreeing.
- **`merged`** is `merge-base --is-ancestor HEAD moving`. False means this work is not on the trunk's
  history at all, which is the exact shape of the incident.
- **`origin/HEAD` is reported but never trusted as the trunk.** When the declared default and the
  moving branch disagree, the briefing says so in as many words: *do not assume the default branch is
  the trunk.*

`fetchedAt` is read from the **common** git dir (`rev-parse --git-common-dir`), not from the
checkout's own `.git`. A linked worktree shares the remote refs of the checkout it was created from,
so asking its own `.git` file would report "never fetched" forever — and §9 means half this box's
sessions run in worktrees.

### The briefing

`repoBriefing(state)` produces the stanza appended to a session's system prompt (§3): the
measurements, timestamped, then exactly one rule.

It is written as **facts with a date on them, not as an instruction to go and check**. The failure
being prevented is a model that had no reason to doubt what it saw, so handing it the answer beats
telling it to be suspicious. The rule at the end exists because the numbers go stale *during* a long
session, which is precisely how the original mistake was made:

> A remote-tracking ref (`origin/anything`) is a local CACHE … before you make ANY claim about what is
> pushed … run `git fetch` first, and check which branch HEAD is on. **If the user says their work is
> already pushed and you cannot see it, they are far more likely to be right than your cached refs
> are.**

That last sentence is the load-bearing one. The incident was not a missing fact — the user supplied
the fact, twice, and lost the argument to a cached ref.

`repoConcern()` / `repoNotice()` are the human-facing half: `off-trunk` (not merged and behind),
`behind` (≥25 commits), `stale` (refs older than `FRESH_MS`), rendered as one amber `notice{kind:"repo"}`
at session birth. Not a duplicate of the briefing — the model gets numbers to reason with; the human
gets the one line that answers *am I about to work on the wrong branch again* without reading anything.

### The sync/async bridge

`ensureSession()` builds a session's whole `query()` **in one synchronous breath** and cannot await a
git call. The routes that reach it can. So:

- **`primeRepoState(cwd)`** — async. Called from `/api/agent/send` before `sendMessage()`, and from
  the autopilot tick. Fetches if stale, measures, leaves the answer in the module cache.
- **`cachedRepoState(cwd)`** — sync, never shells out. What `ensureSession` reads.
- **`repoRootSync(cwd)`** walks up looking for `.git` (a directory in a checkout, a *file* in a
  worktree) so the sync path can find the cache key without `git rev-parse`.

A cache miss degrades to **a briefing one turn late**, never to a stall at session birth. That is the
acceptable failure and the only one; a chat that hangs on send would be a worse bug than the one this
module fixes.

**The fetch inside `primeRepoState` is awaited on purpose.** Fire-and-forget is the obvious choice and
it's wrong: a briefing assembled from unfetched refs is the exact artefact that caused the incident,
and it would be *worse* than no briefing — it carries a timestamp and reads as verified. A warm fetch
is under a second, and `FETCH_COOLDOWN_MS` (5 min per repo) means most sends skip it entirely.

But only up to **`PRIME_BUDGET_MS` (6s)**. Past that the caller gets the pre-fetch state and the fetch
is left running — it still fills the cache for the next turn, and the autopilot tick finishes the job.
Returning the stale state is honest rather than silent: `stale` is true on it, so the briefing says so
in capitals and tells the model to fetch before claiming anything. The first HTTPS fetch of the day can
take tens of seconds while a credential helper wakes up, which is what this budget is sized for.

> 🐛 **A failed fetch does not mean nothing was fetched.** `refreshRepo` originally dropped its cache
> entry only on the success path. But git writes `FETCH_HEAD` and moves remote-tracking refs **as it
> goes** — a run killed by the timeout, or one that exits non-zero on a single ref out of many, can
> still have updated everything. Observed here on the first HTTPS fetch of the day: it blew
> `FETCH_TIMEOUT_MS`, `refreshRepo` returned `false`, the pre-fetch (stale) state was served — while a
> perfectly current `FETCH_HEAD` sat on disk the whole time. The partial success stays invisible until
> the 30s TTL expires, which on a `PRIME_BUDGET_MS` race is exactly the window that matters.
>
> Fix: `cache.delete(root)` on **both** paths. The general form — *a non-zero exit is not evidence that
> nothing happened* — is the same family as "`next build` exiting 0 is not evidence the server swapped"
> (§8), read from the other end.

### Keeping it true for a long session

`freshness` is an autopilot duty (§13) and **the only one that defaults to `true`**, because it is the
only one that is not a write: `git fetch --prune --no-tags` changes what the box *knows*, not what it
*has*. Full reasoning in §13.

Its purpose is duration. A chat briefed at birth is, five hours later, exactly as stale as the refs
that produced it — which is the state this whole module exists to prevent. The tick walks
`liveActivity()`, maps each cwd to a repo root, and refreshes them **serially** with the per-repo
cooldown doing most of the work.

### Verified, by measurement

A detached worktree was created at `aac59c5` — the abandoned homepage commit from the incident — and
measured:

- concern: **`off-trunk`**
- notice: *"237 commits behind origin/develop and not merged into it — work here is not on the line
  that's moving"*
- briefing: named `origin/develop` (tip **49m ago**) as the moving line and `origin/main` (tip
  **25d ago**) as the other candidate.

That is precisely the fact the 5.5-hour session never learned, produced before its first token would
have been generated. The worktree was then removed. Live `~/ecvision` (since moved onto `develop`) and
`~/secondBrain` both measured clean.

### Gotchas

- **`branch` is `null` on a detached HEAD, not `"HEAD"`.** `rev-parse --abbrev-ref HEAD` returns the
  literal string `HEAD` when detached, and rendering that as a branch name is a confident lie. Every
  consumer says "detached HEAD" instead.
- **Worktree detection is two questions, not one.** Inside a work tree *and* `--git-dir` isn't the
  literal `.git`. Same trap §13 names: `.git` is a directory in a main checkout and a file in a
  worktree.
- **`--prune` is not optional.** A deleted remote branch left sitting in the cache is another way to be
  confidently wrong, and it is one this module would otherwise report as a live trunk candidate.
- **A repo with no commits, no remote, no network or no git at all yields `null`** — and therefore no
  briefing and no notice. Every path is best-effort; nothing here may fail a send.
- **Kill switch:** `MINAMI_REPO_FETCH=0` disables fetching entirely (the measurement still runs and
  reports `stale`). Tunables: `MINAMI_REPO_FRESH_MS` (10 min), `MINAMI_REPO_FETCH_COOLDOWN_MS` (5 min),
  `MINAMI_REPO_FETCH_TIMEOUT_MS` (25s), `MINAMI_REPO_PRIME_BUDGET_MS` (6s).

---
