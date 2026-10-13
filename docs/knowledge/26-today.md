# §26 — The Today page

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

`/today`: the morning plan for Thomas's two focus areas (SEO/AEO articles, content videos), the
to-dos, the decisions only he can make, a little research, and the day's log. Built 2026-10-12.

Files: `app/today/{page,Today}.tsx`, `app/api/today/route.ts`, `lib/today.ts`,
`bin/minami-open.sh`, `bin/install-today.sh`. The planner lives in the vault:
`~/secondBrain/bin/morning-heartbeat.mjs` + its prompt `00-09 System/prompts/morning-heartbeat.md`.

## The day, end to end

| When | What | Where it writes |
|---|---|---|
| 07:30 | `com.thomas.minami-heartbeat` runs `morning-heartbeat.mjs`: gathers facts from disk, one `claude -p --model sonnet` (read-only: `--tools WebSearch,WebFetch,Read,Glob,Grep`, `--strict-mcp-config` so no MCP server starts, and a deny list for Bash/Write/Edit and the qone/Slack/Gmail connectors — `--allowedTools` alone only *adds* to the vault's allow list, which already grants Write, Bash and qone) turns them into to-dos + open loops + research | `~/.minami/today/<date>.json`, vault `00-09 System/daily/<date>.md` |
| login | `com.thomas.minami-login` → `minami-open.sh login`: starts the dashboard **only if nothing answers on :3000**, runs the heartbeat if today has no plan (the Mac was off at 07:30), opens `/today` | `~/.minami/today-open.log` |
| 09:00 | `com.thomas.minami-morning` → `minami-open.sh morning`: macOS notification with the headline, opens `/today` | same |
| all day | the page ticks, adds, drops, resolves, reopens, logs notes via `POST /api/today` | the day JSON (atomic rename) |
| next 07:30 | the heartbeat reads yesterday's file (done / not done / answers / notes) to plan today, and rewrites yesterday's vault note as the final record | both |

Facts gathered (no model): `~/ecvisionContent` runs.jsonl (last 4 days), drafts' `gate.json` +
whether `proposed.json` exists, backlog size and top; `~/tiktok-studio` episodes with a stage inferred
from which files exist (there is no status field), the last feedback.jsonl notes, recent research
notes; the two project notes' `phase`/`next_move`/`blocked_on`; the last turns of the thread ledgers
for ecvisionContent, ecvision, tiktok-studio; yesterday's day file. `--facts` prints this bundle at $0.

## The look (2026-10-12, round 2)

Thomas: *"wall of text tho — I want the same UI/UX as ecvision's onboarding."* So the page is
ecvision's `/setup` questions step, reproduced: the golden-hour sky (base `cat-1 24% → cat-6 16%` over
`--k-bg`, three receding glass panes, grain), one frosted card at `min(520px,100%)` radius 30, progress
pills (28px current / 8px others, `transition-all 500ms`), a JetBrains Mono eyebrow ("1 OF 3 · SEO"),
an Inter 700 title at 40px (30px on phones), full-width pill answers where **a tap answers and
advances** (no Next button), "Something else" for free text, Back / Skip for now at the foot.
Colours are ecvision's dark-ground kit tokens copied from `kit.css` (origin/develop), not approximated.
Deviations, on purpose: options keep a one-line consequence under the label (onboarding's are
label-only, but these are real trade-offs), the recommended one carries a SUGGESTED tag, and 1–4 pick
on desktop.

The day view follows the same material: the headline's first sentence is the title and the rest sits
under it small; to-dos show a **title only** (≤60 chars, from the heartbeat's `title`, or derived from
an old plan's first sentence with draft slugs turned into words) and open on tap for the detail, the
command and the hand-off; research, decisions and log are folded. On a phone an "Answer N decisions"
pill pins to the bottom once the hero has scrolled away.

## Hand-offs

Three ways out, all started server-side by `handoff()` in `lib/today.ts` the way §25's Explain is:
**Do it with Minami** (a to-do → a chat in its folder, in the install's default permission mode like any chat — an explicit `acceptEdits` here made every task stop for approval on each command, reported 2026-10-12 — told to ask before anything
outward-facing), **Let Minami decide** (a question → a chat told to take the suggested option unless
the facts say otherwise, then act), **Ask <teammate>** (a chat told to send the question verbatim via
`ask_team`, mode `fire`; tapping the name IS the confirmation, so the chat doesn't ask again). An
answered question can also be handed over afterwards ("Hand all N to Minami" on the last step). The
session id is stored on the item as `handoff`, so the button becomes "Open Minami's chat" (`/?open=`).
A teammate's answer comes back through team-ask, not this page — the next heartbeat doesn't read it yet.

**Where a hand-off runs, and what it's called (2026-10-12).** `handoff()` now places the chat the way
a pane is placed: `isolate(folder, "today-<slug>", "birth")` honours the repo's `minami.isolate`.
An eager repo gives every hand-off its own worktree, and `handoff.cwd` records where the chat
actually runs. Off, or lazy before a write, keeps the folder; then the message names the other
hand-offs live in that folder ("keep to your own task's files; re-read a shared file right before
editing it, and add to it rather than rewrite it"). The message's first line is
`Today · <to-do title>`, which becomes the chat's name everywhere (§5h's title seed, so the board,
the phone inbox, the desktop pill and push notifications all say it).

**`~/ecvisionContent` is `minami.isolate off`**: a shared workspace, set by hand 2026-10-12, undo
with `git -C ~/ecvisionContent config --unset minami.isolate`. The repo is nearly all uncommitted
(drafts, facts, topics and strategy are untracked; last commit 7 days before), and its CMS
credentials are gitignored under `env/`. A worktree is a checkout of HEAD, so a hand-off isolated
there would get an almost empty folder: no drafts, no credentials. Its protection is the "others"
note above, not a branch.

**The page watches its hand-offs** (`app/today/live.ts`). It polls `/api/agent/live`, the same feed
as the tiles, every 3s, only for today and only while the tab is visible. Each handed-off item gets
a chip: ● NEEDS YOU, ◌ WORKING, ✕ FAILED, ✓ REPLIED (turn over, reply waiting), or plain MINAMI when
no live session is left (closed, or the server restarted). Any that needs you goes into a
**"N chats are waiting on you"** card under the hero. A single, single-select question gets its
options as buttons, sent through `/api/glance/answer`, the cover screen's path that resolves the full
question text by need id. Anything heavier opens the chat: several questions, multi-select, a plan,
a held or permission step. Approvals stay in the pane, the same rule the cover keeps (§23).

> 🐛 **"6 agents are live in this folder — they share one branch and will overwrite each other" /
> "a chat asked me something but it's so hard to find" (Thomas, 2026-10-12).** Nine hand-offs put
> six live chats in `~/ecvisionContent`, one checkout, because a pane gets its worktree from the
> browser (`/api/worktree`) before its first send, and `handoff()` starts chats server-side and never
> went through that. All six opened with the same line ("From my Today page (date)…"), so all six had
> the same name on the board, and the page forgot each hand-off once it started. One was waiting
> on a question (publish on bench vs. hold), and nothing on any screen said which. **Fix:** the three
> changes above, plus the desktop "N need you" pill (§3, `components/NeedsYou.tsx`).

## Why it's shaped this way

- **The day file is the contract, and the heartbeat owns its shape.** The page only mutates fields the
  heartbeat defines. A rerun the same day keeps everything he touched (done ticks, his own to-dos,
  answers) and replaces only the untouched suggestions — so "Rebuild plan" is safe to press.
- **Open loops reuse `AskCard`** (the chat's AskUserQuestion wizard) with a page-local `onAnswer`.
  An answer is recorded, logged, and read by the next heartbeat. "Hand all N to Minami" sends the
  answer the server saved, not the last pill tapped (a failed tap is un-lit). It does **not** start a chat or run
  anything — v1 resolves by recording. Wiring an answer to an action is the next step, not an oversight.
- **Never restart a live server from a schedule.** `minami-open.sh` starts `serve.sh` only when no
  next server exists at all (a reboot). A server that exists but is slow is waited on, not replaced —
  a restart would cut every live chat (§8).
- **A model failure still produces a page.** If `claude -p` fails or times out (15 min), the heartbeat
  writes a facts-only plan (drafts awaiting publish, failed stages, each project's next_move) with
  `status: "facts-only"` and the error, which the header shows.
- **Asleep vs off.** launchd runs a missed `StartCalendarInterval` job on wake, but not after a
  power-off; the login agent covers that by running the heartbeat if today has no plan after 07:30
  (not earlier: a boot before 07:30 leaves it to launchd's own job, so the two can't overlap).

## Hardening — the 2026-10-12 audit

Five rounds of three auditors (data · ops · UI) → a cross-examining chair → one fixer; 35 fixes, no
regressions in the final check. What changed in behaviour, so nobody "fixes" it back:

- **The heartbeat re-reads the day right before it saves** and merges into that copy; it never saves
  the copy it read before the 4–15 min model call (that lost every tick made meanwhile). Each writer
  uses its own tmp name. A second run while one is live (<20 min) exits.
- **Nothing he touched is ever replaced**: done, his own, carried, handed-off to-dos and resolved or
  handed-off loops survive a rebuild. A dropped suggestion stays dropped for that day only.
- **Model output is normalised** (`normalise()`): missing arrays, todos with only a title, loops
  without ≥2 labelled options are coerced or dropped; a malformed plan falls back to facts-only.
  Any throw after the first save marks the day `facts-only` with the error — never stuck at `running`.
  The page also treats a `running` older than 20 min as stalled and re-enables Rebuild.
- **The 07:30 model is read-only** via `--tools WebSearch,WebFetch,Read,Glob,Grep` plus an explicit
  deny list — `--allowedTools` alone only ADDS to the vault's allow list, which grants Write/Bash/Slack.
- **API refuses stale edits with a 400** (unknown id, re-answering a handed-off loop, a corrupt day
  file — which is never overwritten). Toggle is idempotent; no-op ops write nothing.
- **Decide**: digits and Escape typed into "Something else" no longer answer/close; double taps can't
  skip a question; a failed hand-off shows its error in the overlay and is not recorded as settled.
- **Fonts are local files** (`app/today/fonts/*.woff2`, committed with `fonts.ts`) so a build never
  fetches from Google.
- **Login**: `minami-open.sh` starts the last complete build (`npm start`) rather than rebuilding,
  detaches what it starts, checks the PORT (`lsof :3000`) rather than `pgrep next-server` (which
  matched every worktree's server), and catches up the heartbeat when the day has no `built_at`.
- **Test seam**: `MINAMI_TODAY_DIR` / `MINAMI_DIGEST_DIR` point both the heartbeat and `lib/today.ts`
  at scratch dirs — never test against `~/.minami/today`.

Still open after the audit: the paid model path and a real carry-over first run at 07:30 on
2026-10-13; no cross-process lock (last writer wins within milliseconds — low risk); dropping a
handed-off to-do loses its chat link.

## Auto-tick (2026-10-12)

Thomas: *"the today page needs a hook or something to show tasks done without me manually input."*
`~/secondBrain/bin/today-sync.mjs`, every 10 min (launchd `com.thomas.minami-today-sync`), reads what
happened today — every chat turn in every folder (the thread ledgers, so work done in a hand-off chat,
a terminal or a dashboard pane all count), drafts' gate state and today's pipeline runs, renders in
`~/tiktok-studio/out`, git commits in the to-dos' folders — and asks the models helper's `text` role
which open to-dos are FINISHED. It ticks at confidence ≥ 0.8 only, stores `done_by: "auto"` and
`done_evidence`, and logs it; the page shows an amber AUTO badge and the evidence, and polls every
60 s while visible. Hand-off chats end with `TODAY: done` / `TODAY: blocked — why`, which it trusts.

Rules that keep it from being annoying: it only ever ticks, never unticks; any to-do he ticks or
unticks himself gets `manual: true` and is never touched again; no model call when nothing new
happened (hash of the open list + evidence in `.sync-state.json`). `topics/published.json` is labelled
as NOT proof of publishing — it lists topics the pipeline used, and the first dry run read it as
"published" (held back only by the threshold). `--dry` prints verdicts; `--force` ignores the hash.

### Checked to-dos — `done_when` (2026-10-13)

Thomas: *"reason on how today minami dashboard need to mark this one as done when this one is done and
do it for other tasks"*, about "Publish the discount-calendar and price-drop pieces". The model judge
couldn't do it: publishing in `/admin/content` leaves no local trace (no ledger turn, no gate change,
no commit), so it would never see the outcome. Also, a day file starts empty, so the next morning's
plan could suggest a finished item again.

- **The mechanism:** a to-do may carry `done_when`, a list of declarative checks written by the
  heartbeat. They live in `~/secondBrain/bin/today-checks.mjs`.
  - `live` checks ecvision.ai's public sitemap at `api.ecvision.ai/api/v1/content/sitemap`. It needs
    no credentials and lists only live articles (ADR-0034 rule 2).
  - `url` (https only), `file` (under `$HOME`, optionally written today), `gate` (a draft's last
    gate entry) and `commit` (today, `-F --grep`).
  - There is no shell or http check, because a model writes these; `cleanChecks` drops anything else.
- **today-sync** runs a to-do's checks every 10 min, before the hash early-return, because they cost
  nothing. When all pass it ticks with `Checked: …` evidence. Otherwise it stores
  `progress {met,total,detail}`, which the page shows as a `2/3` chip plus a line in the detail.
  These to-dos never go to the model, so the judge cannot tick them wrongly.
- **The heartbeat** prompt asks for `done_when` on every to-do with a checkable outcome.
  `normalise` cleans it, `factsPlan`'s "Review and publish" items get a `live` check, and `main`
  runs the checks on the new plan and drops suggestions that already pass. That last step is the
  resurrection fix.
- **A partial result keeps its progress.** A check that couldn't run (network, sitemap 5xx) is
  `unsure` and leaves progress untouched.
- **First user:** to-do `f110e18b`, carried into 2026-10-13 with three `live` checks.

## Gotchas

- His shell exports `PORT=3000` and `NODE_ENV=production`; `minami-open.sh` unsets both, and the
  plists set their own `PATH` (launchd has none of his shell).
- `minami-open.sh` exports the PATH his login shell would give (`~/.local/bin` for tools/models/tok,
  Python 3.11, Homebrew), prepended by hand rather than via `zsh -lc` so the NODE_ENV/PORT unset wins.
  The server it starts after a reboot hosts every chat, and chats inherit its env: on launchd's bare
  PATH, `tools find` / `models resolve` failed and `python3` was the system 3.9 (fixed 2026-10-12).
- The page's fonts are local woff2 files (`app/today/fonts/`, `next/font/local`), never
  `next/font/google`: that made every dashboard build fetch Google Fonts, and `next build` replaces
  `.next` under the live server, so an offline deploy could leave nothing serving. Inter's Vietnamese
  subset is a second face chained in the font stack (`--today-sans-vi`).
- Login recovery never builds while a build is on disk: if nothing answers on :3000,
  `minami-open.sh` runs `npm start` on the existing `.next` (it has a `BUILD_ID`), and only falls
  back to `bin/serve.sh` when there is none. The working tree is the dashboard editing itself, so it
  can hold half-done code, and `next build` clears `.next` first. One compile error would leave
  nothing serving all day.
- launchd reaps a job's whole process group when it exits, and `nohup … &` doesn't leave it. So
  anything `minami-open.sh` starts (serve.sh, the catch-up heartbeat) goes through its `detach`
  (setsid); the two open plists also set `AbandonProcessGroup` as a backstop. The heartbeat plist
  deliberately doesn't — the group reap is what cleans up a timed-out `claude`.
- The login agent is installed but not bootstrapped (it's `RunAtLoad`, so loading it opens the page
  immediately); it takes effect at the next login.
- Cost of a plan: ~$0.20 on Sonnet (first run, 2026-10-12). Research is optional in the prompt; the
  first run did none.

> 🐛 **2026-10-12 — a dev server overwrote the production build.** While building this page,
> `npx next dev -p 3012` was started without `NEXT_DIST_DIR=.next-dev`. It wrote its dev output into
> `.next`, deleting `BUILD_ID` and the production chunks under the live :3000 server. The process kept
> serving HTML from memory (`/` → 200) but every `/_next/static/chunks/*.js` it referenced was gone,
> so any fresh page load would come up dead. Fixed by `bin/deploy.sh --detach` (a full rebuild + swap
> when the box is quiet). **Always start a side dev server with `npm run dev -- -p <port>`** — the
> script sets `NEXT_DIST_DIR=.next-dev`; a bare `next dev` does not.

## Task status (2026-10-13)

Thomas: *"the UX are not showing clear status of tasks"*. The two days on record said why:

- **Oct 12:** 9 to-dos and 7 hand-offs, **none ticked**, though three had finished. Three publish
  tasks hit the same wall ("no prod CMS target") while the task that settles it ran beside them. One
  chat ran 17½ h and edited an ADR in `~/ecvision` and this repo's own `lib/today.ts`. Nothing on the
  page said any of this.
- **Oct 13:** 4 hand-offs all ended "TODAY: done" and **one** was ticked, by other evidence. The
  vault checker read the thread ledger, which keeps the first 320 characters of a reply, and the
  status line is the last line. "Done" also hid two different things: the price-cut draft's
  part was done but it waited on Thomas to publish, and the updated-date check said done and then
  reported Docker wasn't running.

So the page shows what the **task** is doing, not what the chat is doing:

| State | When | Line under the title |
|---|---|---|
| ● NEEDS YOU | the chat has a question or step pending | the question |
| → YOUR MOVE | last status line `TODAY: yours — …` | what only he can do |
| ■ BLOCKED | `TODAY: blocked — …` | the blocker |
| ◌ WORKING | the chat is busy | — |
| ⏸ AFTER | an `after` prerequisite isn't done and it hasn't started | which one |
| ✉ READ REPLY | the turn ended with no status line, or a newer message followed the line (`stale`) | why |
| ✓ DONE | ticked | by whom: Minami reported / a check / the judge |

- **`lib/today-status.ts`** reads each hand-off's transcript, with no model involved. The last
  `TODAY:` line wins. It's `stale` if assistant text follows it, so a correction is never ticked
  over. Results are cached per file version.
- **`reconcile(date)`** (GET `/api/today`, today only) ticks a to-do whose line is a non-stale `done`.
  It sets `done_by: "minami"`, never touches a box he set himself (`manual`), and writes only on
  change. The page polls every 20s while hand-offs are out.
- **The contract** (`STATUS_CONTRACT`, in the hand-off message): `done` / `yours — <the one thing
  only I can do>` / `blocked — <under 8 words, worded the same every time>`. The line is repeated on
  any later message, so the latest message always carries it.
- **Blockers are grouped** by their lower-cased words ("no prod CMS target" and "No prod CMS
  target." are one group), in a card under the hero. "Your move" gets its own card with a Done button.
  The hero shows the honest split, e.g. "1 done · 1 your move · 2 blocked · 2 to read".
- **`after`** is written by the heartbeat as 1-based positions in its own list (it can't know the ids,
  which are a hash of the text). `normalise` turns them into ids. The page holds a dependent task's
  start button ("Minami can start this after: …"), and `handoff()` refuses with the same message.
- **Drift:** ⚠ when a chat has run ≥ 120 min without finishing, or edited ≥ 3 files outside its
  to-do's folder and worktree. Vault notes, scratch and harness state don't count. One or two edits
  next door is a task using its tools; five, an ADR included, was the drift.

Verified 2026-10-13 against a scratch day (`MINAMI_TODAY_DIR`) built from five synthetic transcripts
plus two real chats. Every state rendered, two blocker wordings merged into one group, the `done`
ticked as `minami` and the stale one didn't, and the 17½ h chat showed `running 17h 32m · edited
outside its folder: …ADR-0034…, ~/minami-dashboard/lib/today.ts`. A direct POST to hand off the
dependent task returned `starts after: Settle where articles publish`. Not yet run against a real
morning's hand-offs under the new contract.

> 🐛 **The status line the checker trusted was cut off before it could read it.** today-sync.mjs read
> the thread ledger, which keeps the first 320 characters of a reply. Every "TODAY: done" sat at
> the end, so all four of Oct 13's lines were absent from the data the judge was shown. **Fix:**
> parse the transcript (above). today-sync keeps its job for to-dos with no hand-off.

## "Done" with nothing on ecvision.ai (2026-10-13)

Thomas: *"those articles are not on production ecvision.ai — check why it's done"*. The public sitemap
(`api.ecvision.ai/api/v1/content/sitemap`) listed **0** posts while the page showed four ticks under a
"publish before Black Friday" headline.

- **Every tick was a step.** Finish the draft, add a section, check the dates, queue a topic: each
  done, none of them "live". Only the carried "Publish the discount-calendar pieces" had `live`
  checks, and it correctly read 0/3.
- **Publishing was Thomas's tap by design.** The ecvisionContent rule was that agents never call
  `publish_article`, and the page never said the last step was his.
- **"Proposed" meant three things.** Prod was wired at 09:04 (`env/prod.env`), but the pipeline
  defaults to bench. Three drafts were in the prod CMS. Seven, the price-cut piece among them, were in
  bench only, which reaches nobody. The heartbeat ran without `CONTENT_ENV`, so it concluded "no prod
  target" anyway.
- **A tick landed mid-stage.** "Add a BFCM section" was ticked by the vault judge while verify was
  still running.

**What changed.** Thomas: *"can publish using agent already - no more tap"*.
- **The first three went live (verified in the sitemap and HTTP 200).** The ecvision-content skill,
  ecvisionContent's CLAUDE.md and the pipeline now say agents publish on prod only, after gates,
  on the Today stagger, confirmed in the sitemap.
- **vault `bin/content-funnel.mjs`:** per draft live / prod_waiting / bench_only / in_progress,
  from the sitemap and `proposed.json` / `gate.env`. today-sync writes it to `day.pipeline.seo`
  every 10 min, and the page shows it as one line under the hero ("SEO 3 live on ecvision.ai · 5 on
  bench only · 3 in progress"). The heartbeat gets it as facts, and `hasProd()` replaces the
  `CONTENT_ENV` guess.
- **The heartbeat prompt plans the outcome:** a publishing headline needs a to-do with `live`
  checks. Bench-only drafts need "re-propose on prod" first. Publishing goes in "Publish <slug>"
  to-dos, at most 2 a day unless the strategy says otherwise.
- **The today-sync judge** gets `drafts_now`. A draft whose stage is running or failed isn't done,
  and only `live` is published.
- **pump.mjs:** a prod run sets a bench `proposed.json`/`card.md` aside first. Without that, all 8
  drafts failed: the stage chased the bench article id on prod and got a 404. The three that had
  reached prod got there only because their bench files had been renamed by hand. The gate now
  records `env`.

