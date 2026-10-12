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
