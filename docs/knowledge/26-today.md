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
| 07:30 | `com.thomas.minami-heartbeat` runs `morning-heartbeat.mjs`: gathers facts from disk, one `claude -p --model sonnet` (WebSearch/WebFetch/Read/Glob/Grep only) turns them into to-dos + open loops + research | `~/.minami/today/<date>.json`, vault `00-09 System/daily/<date>.md` |
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
**Do it with Minami** (a to-do → a chat in its folder, `acceptEdits`, told to ask before anything
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
  An answer is recorded, logged, and read by the next heartbeat. It does **not** start a chat or run
  anything — v1 resolves by recording. Wiring an answer to an action is the next step, not an oversight.
- **Never restart a live server from a schedule.** `minami-open.sh` starts `serve.sh` only when no
  next server exists at all (a reboot). A server that exists but is slow is waited on, not replaced —
  a restart would cut every live chat (§8).
- **A model failure still produces a page.** If `claude -p` fails or times out (15 min), the heartbeat
  writes a facts-only plan (drafts awaiting publish, failed stages, each project's next_move) with
  `status: "facts-only"` and the error, which the header shows.
- **Asleep vs off.** launchd runs a missed `StartCalendarInterval` job on wake, but not after a
  power-off; the login agent covers that by running the heartbeat if today has no plan after 06:00.

## Gotchas

- His shell exports `PORT=3000` and `NODE_ENV=production`; `minami-open.sh` unsets both, and the
  plists set their own `PATH` (launchd has none of his shell).
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
