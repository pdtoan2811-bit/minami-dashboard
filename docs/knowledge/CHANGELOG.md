# Changelog

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

Newest date first, absolute dates only. This is an append log — it is here so that the subsystem docs
stay about *how things work* rather than growing a history section each. You almost never need to read
this to do a piece of work; read the subsystem's own doc.

---

### 2026-09-03
- **The shared-folder banner learns about lazy repos** (§9) — `GET /api/worktree` now returns the
  repo's `minami.isolate` mode, and the amber "will overwrite each other" warning only fires for
  eager repos. Lazy (the vault): a quiet neutral line — sharing is the designed state, the
  placement pass isolates on the first contended write. `off`: no banner. Unknown reads as eager,
  because the safe default for a warning is to fire.
- **🐛 Background agents survive the turn boundary on the board** (§4) — `result` no longer wipes
  still-running tasks; phase stays `tool` while they fly, and the pane shows the bay in the banner
  slot when idle-with-agents (+3min grace so landings are seen).

### 2026-09-02
- **Per-repo isolation opt-out: `git config minami.isolate off`** (§9) — born from the secondBrain
  strandings (four worktrees piled up; a vault compaction ran invisibly in one — full post-mortem
  in §9). Checked in `isolate()` before any name allocation; unset means on. Set in secondBrain,
  then reversed the same evening — the vault keeps per-chat isolation and its own
  `prune-worktrees.sh` now recycles finished branches instead (stale-claim aware, auto-merge,
  origin cleanup). Stranded content rescued into the vault's `main`; chat-6 reconciled.
- **🐛 New vault chats woke up inside chat-6's worktree** (§5d, §9) — a topic's cwd was
  `ss[0].cwd`, i.e. whichever session sorted first, and for secondBrain that was a session recorded
  in `.minami-worktrees/chat-6`. Every blank pane inherited the dead tree's address — and birth
  isolation silently disarmed itself for months, because `isolate()` declines when the cwd is
  already a worktree. Topic cwd now prefers a non-isolated session's cwd and folds the suffix
  otherwise. Related: a REHOMED transcript (placement pass / recycled-tree rescue) records a launch
  cwd that no longer encodes to the directory it is filed in; `buildMeta` now detects the mismatch
  and folds to the base that does encode back (META_DERIVATION_VERSION → 5), so resuming a migrated
  chat can't hunt in the wrong project dir.
- **The placement pass: a chat follows its work** (§9) — `minami.isolate lazy` (vault: set) skips
  the birth worktree; at idle turn-ends the server reads the session's write targets and either
  relocates the chat to the repo its work is in (≥2 writes there; transcript moves with it, board
  re-tiles, pane shows a green moved-bar) or grants the worktree lazy mode declined once the home
  repo is written under contention. Designed from a 10-question interview; scoped to lazy repos.
- **AgentBoard v2 — the bay** (§4): one container, formation-strip header (a breathing dot per
  running agent), rows on a shared grid; motion keyed to real events only (launch, tool change,
  landing), reduced-motion respected. Verified against a rendered mock before shipping.
- **Stranded-chat rescue: `rehomeStrandedTranscript()`** (§9) — resuming a chat whose recycled
  worktree is gone now moves its transcript to the base folder's project dir and continues there.
  The 29 already-stranded secondBrain transcripts were migrated by hand the same day.
- **Localhost is the primary preview** (§5c) — prompt orders it first, the parser stable-sorts it
  first regardless, and its chip renders as the one accent-tinted primary action with host:port
  visible. Hostname-checked (`isLocalUrl`), not substring-matched.
- **AgentBoard: the subagent fleet as a roster, not pills** (§4) — one row per running agent with
  type badge, assignment, current inner tool, tool count and a per-agent timer (`LiveTask.since`,
  stamped at `task_started`; deliberately absent on adopted background tasks). Finished agents stay
  in the same list dimmed with a verdict glyph. One-line contexts say `4 agents · Explore ×3, Plan`
  instead of `subagent (Explore) +3`. Fan-out mode made fleets the common case; this makes them
  legible.
- **Fan-out mode + the preview ending contract** (§3, §5c) — two composer-level features. (1) A ⑂
  pill (default ON, fallback `MINAMI_DASHBOARD_FANOUT`) appends `FANOUT_PROMPT` at session
  creation: propose parallel subagents for divisible work and proceed without asking; procedure in
  the user-level `fanout` skill on this box. Creation-only like `model`, so the toggle mirrors the
  model swap end to end (`/api/agent/fanout` → `setFanout()`, teardown + resume). (2) Every session
  is asked to end viewable work with a ` ```minami-preview ` JSON block; `lib/preview-block.ts` +
  `PreviewChips` render it as clickable chips (url/file/cmd) at the bottom of the reply — "where do
  I preview this" stops being a follow-up question. Restructured on the way: the systemPrompt append
  was bundled inside the `MCP_SERVERS` spread, so a browser-disabled install silently lost every
  append; the append is now unconditional with per-piece gates.
- **Model lineup: Fable 5.1 replaces Fable 5 in the picker** — per Anthropic's models page (checked
  this date), `claude-fable-5-1` is the current frontier tier (long-horizon agentic work, $10/$50
  per MTok) and Fable 5 is legacy. `lib/model-catalog.ts` offers 5.1; `lib/routing.ts` adds the tier
  with Fable 5 demoted to a legacy row like Opus 4.8 — **5.1 must sort before 5 in `MODELS`**,
  because `tierFromModel` matches by substring and `claude-fable-5-1` contains `claude-fable-5`.
  `server/metrics-server.js` mirrors the price. The box pin stays `claude-opus-5`. Old Fable 5
  sessions still tier and price correctly via their own legacy row.
  🐛 found on the way: `npm run check` was red on "tunnel url skips api.trycloudflare" — not a
  regression in the guard, a stale check. e7ed996 moved the `//api\.` filter into `bin/tunnel-lib.sh`
  with the rest of the tunnel helpers, and the check still grepped only `Minami Call.command`. The
  check now reads the file the guard lives in. Lesson: a source-grep check must move when the source
  it greps is refactored, or it fails green code.
- **Attaching files: drag-and-drop, and the real macOS open panel** (§5e) — new `/api/fs/choose`
  (`osascript`, returns a POSIX path so nothing is copied) and `/api/fs/drop` (bytes fallback into
  `~/.minami/drops/`). The 📎 button became a menu naming the trade: native panel for files Claude
  should *edit*, in-app browser for a pane opened from the phone. Drops prefer the real path from
  `text/uri-list` and fall back to uploading; a dropped folder with no path says so rather than
  attaching a zero-byte file. All four routes end in the same "put a path in the textarea" operation.
  🐛 fixed on the way: a percent-encoded `x-filename` was never decoded, so `my notes.ts` was written
  as `my_20notes.ts`.

### 2026-08-26
- **🐛 Prompts no longer strand a pane until F5** (§3) — `ask`/`permission` are the only non-REPLACE
  events in the live pipeline: broadcast exactly once, with replay-on-subscribe as the sole second
  chance. One lost delivery left the session at `phase=awaiting` with "waiting on your answer" showing
  and no card, recoverable only by reloading. `useAgent` now watches for the contradiction (server
  blocked on the user + pane holding no prompt) and re-subscribes after `AWAIT_HEAL_MS`, once per
  episode. New `resync()` — `attach()` couldn't do it, since `ensureStream()` no-ops on an open stream.
  Proven by fault injection, with the happy path opening no extra stream.
- **AskCard renders `options[].preview`** (§3) — the AskUserQuestion schema field carrying a mockup,
  snippet or plan per option. `manager.ts` had always broadcast it verbatim; it was missing from
  `AgentQuestion` in `lib/use-agent.ts` and from the card, so 27 questions in local transcript history
  shipped previews that were silently dropped. Renders inside the option row (the one scrolling
  region) — never a new pinned block, or a long preview would push "Send answer" out of a short pane
  and strand the session at `phase=awaiting`. Open state follows the selection by default, with an
  explicit per-option toggle so previews can be compared without picking one.
  Verified on `:3001` with a real 4-question ask at a 560px viewport: options clip and scroll, the
  action row stays visible.
- Checked while scoping this: the question cap is still **1–4**, in both CLI 2.1.241 and SDK 0.3.220.
  No version has asked 5, and none of the 466 recorded asks had more than 4.
- **Model picker in the composer's control row** (§3) — new `/api/agent/model` + `setModel()`, the
  catalog from `lib/model-catalog.ts`, persisted per session with a global seed like `perm`. A warm
  session's model can't be changed, so the swap tears the session down and the next send resumes the
  conversation from disk; refused mid-turn. Two things this needed that aren't obvious: handing the live
  SSE subscribers to `waiting` across the respawn, and re-arming `sentOnce` so the next send actually
  passes `resume` instead of silently starting a context-less session. The pill names what the SESSION
  reported at init (the pin is server-only and must not be mirrored client-side), and a sakura dot marks
  a pick that hasn't started yet — derived from pick-vs-reported disagreeing, not from a flag.
  Verified end-to-end on `:3001`: a chat started on Opus, swapped to Fable mid-conversation, then
  recalled the codeword from before the swap and reported `claude-fable-5`.

### 2026-08-25
- **The canvas's own strings now follow the meeting's language** (§17) — new `lib/canvas-lang.ts`.
  The judge already wrote cards in the language people were speaking; everything the *app* wrote was
  hardcoded English sitting on top of it, so a Vietnamese call got "MILESTONE" stamped over "Meme cut
  scene chạy được rồi". Fixed in the cut-scene caption and the presence badge. Language is **detected
  from the board**, not read from `sttLang` — that configures the ear, is often unset, and is one
  value for a call that code-switches. Detection uses two independent signals (diacritic ratio,
  Vietnamese function words), each with a floor, so one borrowed proper noun cannot flip a board.
  The Chrome overlay in `~/Minami/extension` carries a copy of the tables and a port of the detector.

### 2026-08-24
- **Meeting launch is a documented subsystem now** (§18, new `docs/knowledge/18-meeting-launch.md`) —
  the two launchers, the receiver, the tunnel and the Recall dispatch had no owning doc, so four
  incidents' worth of hard-won tunnel logic lived only in shell comments.
- **The launcher stopped poisoning its own DNS** (§18) — `trycloudflare.com` publishes an SOA minimum
  of 1800, so the probe fired at the hostname the instant cloudflared prints it earns an NXDOMAIN that
  the resolver pins for 30 minutes, and every later probe in the run reads that lie. The `dig`
  fallback was a bare `dig`, so it drank from the same poisoned cache. New `tunnel_dns()` resolves via
  `@1.1.1.1` → `@8.8.8.8` → local. Detection went from never to ~1s on a tunnel that was live the
  whole time.
  *Reported by user: "stuck on step 3 and cannot launch"*
- **The tunnel wait is a wall clock, not a pass count** (§18) — the old loop ran 30 passes and added a
  flat `+2` to the on-screen counter each pass, so the number described the loop's assumptions rather
  than the time. `TUNNEL_WAIT=180`, real elapsed shown against the real deadline, and the give-up
  message now separates "printed but never answered" (retry) from "no url at all" (read the log) —
  `tunnel.log` reports PASS on every pre-check either way, which is why a working tunnel read as a
  network fault.
  *Reported by user: "take so long to answer"*
- **`bin/tunnel-lib.sh` — one copy of the tunnel probe, sourced by both launchers** (§18) —
  `meet-now.sh` still carried the generation-one logic and therefore all three bugs `Minami
  Call.command` had already paid for: any-response-counts liveness, `head -1` picking Cloudflare's own
  api host, and dispatching a bot the moment a hostname is *printed* rather than served.

### 2026-08-12
- **A queued message is now visible in the chat log for all three of its lives** (§5f-bis) — waiting
  (dashed bubble in the transcript, rendered off `agent.queued` so reconcile can't wipe it), running as
  its own turn (new `started` SSE event carries the text the server is about to forget, so the pane can
  append a real user turn), and **coalesced into an already-running turn** — which was the bad one: the
  CLI writes no `user` row in that case, only an `attachment` row with `attachment.type ===
  "queued_command"`, so the message was on disk and in no view built from it. The reply answered a
  question that appeared nowhere. `parseLines` folds that row in now. Caught by driving a real session,
  not by reading the diff — and then the fix appeared not to work because `getSession`'s `turnsCache` is
  keyed on mtime+size only: `PARSE_VERSION` guarded the meta cache but not the turns cache, so every
  already-parsed transcript kept its old fold. The turns cache now carries `pv`.
- **Flow v5: the last three calls, and the stack they worked in** (§5f) — the milestone node now
  previews its three newest tool calls and a row of brand icons for the tech those calls actually
  touched. New `lib/flow-stack.ts` derives the slugs from the calls themselves, not from
  `lib/tech-attach.ts` — the project's own stack is identical on every milestone and so carries zero
  information inside this view, while the calls are what differ from ask to ask. Whitelist tables, so
  an unmapped extension contributes nothing rather than a guess. Needed `FlowTurn.tools` (a
  chronological list), because "the latest 3" is a claim about time and flattening `steps` yields plan
  order. Two bugs found by driving `:3001` rather than reading the diff: a `\bplaywright\b` command
  rule that matched `find -iname "*playwright*"` (deleted — match commands that are *run*, not words
  that are *mentioned*), and three MCP calls rendering as identical clipped `MCP__PLAYWRIG…` prefixes
  (now `CLICK · EVALUATE · TAKE_SCREENSHOT`).
- **Tech icons filled in for six topics** (§5d) — `dataAnalyticsOwnego` and `CV` had empty rows;
  `Minami`, `secondBrain`, `qdn`, `toolkit` had only their git host. Detection wasn't broken: those
  projects have no `package.json` deps that match, or none at all, so `getAttach` had only
  `.git/config` to read. Assignments in `~/.minami-bento/icons.json`, each inferred from real evidence
  (BigQuery MCP servers, `@slack/bolt`, "Obsidian is the IDE" in the vault's CLAUDE.md). Separately:
  `playwright` and `slack` sit in `WANT` in `bin/build-tech-icons.mjs` but simple-icons v16 ships
  neither (trademark removal), so they fall through to `BrandIcon`'s lettermark tiles — by design, but
  the build does not warn that a wanted slug produced nothing.

### 2026-08-10
- **Canvas A/B harness shipped, and it overturned two of the predictions that motivated it** (§17) —
  `?mode=mimo|stt|stt-fast` runs the same audio down three pipelines, each changing one variable, and
  emits a `report` the panel keeps per arm. First run: the control arm produced **nothing at all** in
  175s (three blank transcription replies on its single chunk), while the real-ASR arm had a
  transcript in 1.4s — **but that run was measuring the max_tokens bug, not the arms.** Re-run after
  the budget fix, the conclusion inverted: arm A works, costs **$0.030/audio-hour** and finishes in
  55s; arm B costs **$1.43** and takes 165s, while still winning first-transcript 9× (1.3s vs 11.5s)
  and first-card 2×. The ASR leg matched research exactly ($0.11/hr); the judging leg is the whole
  expense. The predicted "~$0.10/audio-hour all-in" was wrong either way. Also **disproved
  diarization-through-OpenRouter**: `provider.options` is accepted and silently ignored, so speaker
  labels never arrive. Cost is read from `usage.cost`, not computed.
- **Restored the max_tokens fix that a concurrent edit had reverted** (§17) — `2442a90`'s message
  documents budgets raised to 6000–7000, but the committed code still had 600/900/2000: this session
  was editing the same functions in the same minutes and its string-replacements wrote the old values
  back before the commit was made. Budgets are now 7000 (transcribe) / 6000 (judge, relations),
  retries double the budget rather than repeat it, and `finish_reason: "length"` with empty content
  throws with the token count. *A commit message is not evidence the code does what it says.*
- **Canvas panel: configure-then-Start, instead of run-on-click** — every selector used to launch a
  billed run the moment it was clicked, so picking an arm and picking a duration were two runs and
  there was no way to change your mind. Selection is now a draft with an explicit Start button and a
  summary of what it will do. *Reported by anh: "like a trap that I select then run right away."*
- **Meeting canvas documented, and its root defect named** (§17) — new doc for `/canvas`, which had no
  entry in this record at all. `transcribe()` uses a chat LLM (`xiaomi/mimo-v2.5`) for ASR, which is
  what drives all three complaints: ~13s per audio-minute, ~1 chunk in 3 returning `content: null`,
  invented speaker labels, and Luna/Lumen/Luno across identical runs. OpenRouter shipped a dedicated
  `/api/v1/audio/transcriptions` endpoint after this pipeline was written; catalogue, prices and the
  batch-only constraints are recorded. Replacement specified — `x-ai/grok-stt-1.0` at $0.10/audio-hour
  is the only model meeting anh's mixed-language + diarization constraints — but **nothing was built
  and nothing was measured**. Two things must be tested before building: whether diarization survives
  OpenRouter's `{ text, usage }` response shape, and that Nova-3's `language=multi` excludes Vietnamese.

### 2026-08-06
- **Auto-isolation audit: the discard path could delete a checkout under a running agent** (§9) —
  `discardIfPristine` called `task.mjs rm --force`, and `cmdRm` gates its occupancy check on
  `&& !force`. The substitute dirty-check could never catch it: the claim file is gitignored, so a
  claimed tree reports zero dirty files. Fixed by dropping `--force` and checking the claim in
  `lib/worktree.ts` as well; proved against a real worktree that a claimed tree now refuses removal.
  Same pass: name allocation reads `refs/heads/task` so a stale branch is not silently remounted,
  isolate retries on a name collision instead of falling back to no isolation, and the `task.mjs`
  backend is confined to the dashboard's own checkout rather than any client-named repo.
- **Token economics measured, and the `claude-api` skill demoted** (§16, new) — that skill inlines
  ~137k tokens and fires on a very broad trigger; the audit needed two numbers out of it. Both now
  live in `docs/knowledge/16-token-economics.md` with a one-line pointer from CLAUDE.md. The
  measurements: 445 transcripts, 50,694 turns, 96.7% cache hit ratio; **cache writes are 3.4% of
  tokens and ~30% of spend** because a write costs 12.5–20× a read. Auto-compaction turns out to be
  **inert** — 7 events ever, so tuning `AUTOCOMPACT_PCT` saves nothing — and the real lever is cold
  resumes, driven by 71 logged deploys (49 in one week) each ending every session on the box.
  Raising `IDLE_REAP_MS` was considered and rejected: deploys kill idle sessions first.
  *Requested by user: "audit these things … the session creating and closing with context or auto
  compact memory to save usage" / "the previous file you read … is too damn long and token consuming".*

### 2026-08-03
- **A second chat in a folder now gets its own checkout** (§9, §13) — the worktree tooling had been
  complete and unused for weeks because the middle step was manual, which is why §9's occupancy guard
  had never once evaluated true. New `lib/worktree.ts` + `/api/worktree`: a blank second-or-later chat
  in a git repo is silently given its own worktree at creation (`MINAMI_AUTO_ISOLATE=0` to switch off),
  `task.mjs new` grew `--json` and now links `node_modules` at creation rather than at first build, and
  closing an isolated pane discards the tree if it is pristine. `topicOf` folds a worktree path back to
  its parent repo so an isolated chat stays on its own tile (`META_DERIVATION_VERSION` 3 → 4). The amber
  "N agents are live in this folder" banner is now two-state: it reports isolation with a `merge back`
  button, and only warns when the folder is genuinely still shared. Merge-back goes through
  `task.mjs merge`, so the autopilot and the button share one set of gates.
  *Requested by user: "Upgrade the auto pilot to somehow automatically create worktrees. or do
  something that optimize the process".*
- **The selected chat tab is a fill and a tail, not a shade of pink** (§5e) — selection and activity
  were drawn on the same two channels *and* the same hue (`PHASE_TINT.thinking` is `var(--sakura)`),
  so "which am I reading" was sakura @60/10% against "thinking" at sakura @55/9%. Selection moved off
  colour: the selected tab is the only filled one, a running tab is outlined with no wash, and a
  `.tab-caret` triangle hangs under the selected tab pointing at its transcript. The row's vertical
  padding moved onto the scroll container so the tail isn't clipped (`overflow` clips at the padding
  box); row height unchanged. *Reported by user: "chat panel tab are being chosen need an indicator
  something like a triangle arrow since the color clues are not really intuitive anymore".*
- **The deploy guard could be disabled by one unlucky poll; verification blessed a broken app** (§8) —
  `busy_now()` in `bin/deploy.sh` returned `""` for a 403, a 500, a timeout *and* for "no server", and
  the wait loop treated `""` as permission to proceed. It is now three-valued (count / `""` only on
  connection-refused / `"?"` = unknown), and unknown keeps waiting then fails closed. Separately
  `verify()` passed on `GET / -> 200` while every `/_next/static/*` asset 400'd and `BUILD_ID` was
  empty; it now fails on both — reproduced against the live broken box, where `--verify-only` went from
  reporting success to exit 1. The failure alert now tails the deploy log (the actual refusal) instead
  of `prod.log` (the previous boot's success). Autopilot inherits all three, since it deploys by
  spawning this script. *Requested by user: "audit the auto pilot and investigate the latest failed
  deploy and fix — check with at least 5 hypo"*
- **Chat text renders its structure again** (§5c) — the block parser threw away everything a typed
  message used to convey shape: list indentation was matched then discarded (so nested bullets came out
  flat), every line became its own `<p>` (so two lines of one thought got a paragraph of air), an
  indented continuation line escaped the list, `3.` rendered as `1.`, and consecutive `>` lines drew two
  quote bars. Lists are now parsed into a tree by indent with real hanging indents, paragraphs group
  their lines with `<br/>` (a single newline is a line break — this is a chat panel), `<ol start>` is
  honoured and quotes merge. Both bubbles share the renderer, so the sent prompt gained all of it too.
  *Reported by user: "I tried to convey a list and bullet points — however the xuống dòng, lùi đầu dòng
  is not really intuitive … I want something matching the Claude Code desktop app"*
- **`dev:iterate` pins `NODE_ENV=development`** (§8) — the shell profile exports `NODE_ENV=production`,
  which made the script 500 every route on the Tailwind import. Working around it by hand with a bare
  `npx next dev` drops `NEXT_DIST_DIR` too and writes dev output into `.next` under the live server;
  that happened here and broke `:3000` until a redeploy. Post-mortem in §8.
- **The topic picker is one fixed size in every state** (§5d) — it was `max-h-[70vh]`, so it sized to
  its content: switching Recent↔Browse or stepping into a differently-sized folder resized it, and
  because it's centred it moved vertically too, sliding rows out from under the cursor. Now
  `h-[70vh] max-h-[34rem]`; the list scrolls instead. Measured identical (544×512 at 1280×800) across
  both tabs and a two-entry folder. *Reported by user: "consistent size of popup please"*
- **The chat tab row: a sweep while running, and a selection that means something** (§5e) — a running
  tab now also carries an indeterminate phase-tinted bar along its foot (`.tab-run-sweep`); the 6px
  ring only works if you are already looking at the dot, which is the one thing you are not doing.
  Opening a topic sorts its tabs newest-interaction-first (remembered panes came back in insertion
  order) and lands on the running one, else the most recent — `activePane` used to survive a project
  switch untouched, so you arrived on an index chosen by the topic you left. Nothing re-sorts or
  re-selects while you are *in* a topic, on purpose. Verified on `:3001` against a deliberately
  oldest-first remembered set and a stubbed busy session.
  *Reported by user: "in the chat panel need animation for tab is running, auto open and sort tab with
  recent interaction when navigate across tiles etc".*
- **The new-topic picker opens on Recent, not on the filesystem** (§5d) — new `lib/topic-rank.ts` ranks
  topics by depth × recency plus a "did you come back on another day" term, which is what separates a
  focused project from a folder that was busy once. Floors (`MIN_REQS`, a 0.2×leader relative cut) and
  outright exclusions (`/tmp`, `/var/folders`, `$HOME` exactly) clear the noise: on this box they
  removed two smoke-test fixtures and `~` from the top eight. `FolderPicker` gained Recent/Browse tabs;
  Browse and the attach picker are unchanged. Verified in the browser on `:3001` — Recent lists six real
  projects, and clicking one opens that topic with its `--continue` offer intact.
  *Requested by user: "a short list of top 5-10 recent topic … with a ranking to clear noise from
  folder/topic that's not really focused … then a tab navigation to switch between that UI with actual
  folder directory pick UI"*

### 2026-07-31
- **Project icon motion split into three layers** (§5e, §12) — the tumble, the hover lift and the
  press each own their own element, because `transform` is one property and an `animation` takes it
  outright. The loop is now *paused* at rest rather than added on hover, and the static pose equals
  the `spin3d` 0%/100% keyframe, so hovering no longer snaps in and out. Live tiles use
  `.motion-icon-live` + `--icon-spin` instead of an inline `animation` that outranked — and so broke —
  both the hover rule and the reduced-motion kill-switch. Hover gained `:focus-visible` parity and a
  press state; the keyframes gained a small vertical bob so the glyph reads as an object with weight.
  *Reported by user: "more robust icon movements and hover effect".*
- **Flow view v4 — the session journey** (§5f) — the canvas is no longer one turn at a time with a
  pager, and no longer draws a node per tool call. One spine per **session**, one node per **ask**,
  each saying what was wanted and how it turned out; phases and their evidence one click in, the raw
  tool log two. New: a nine-kind semantic act layer and `buildJourney()` in `lib/flow-model.ts`,
  `lib/flow-narrate.ts` (Haiku writes the outcome sentence, cached to
  `~/.minami-bento/flow-narratives.json`, `MINAMI_FLOW_NARRATE=0` to disable), `/api/flow/[id]`
  (narratives only — never a second copy of the fold), `Turn.cost` in `lib/claude-sessions.ts` (§1),
  and a progress meter with **open loops** — plan items started and never closed. `cleanAsk`/`isAck`
  were derived by folding **386 real transcripts**, not guessed: they drop 204 of 1,128 phantom
  milestones (pasted-image markers, self-loaded skill bodies, auto-resume preambles, "go"/"continue").
  Three bugs found by driving the app, all "state that fought itself" — see the v4 post-mortem.
  *Reported by user: "Tool use log is too much detailed and noise, which is awful. I want the semantic
  intuitive idea of goals of each step and how AI handled it."*
- **The module graph claimed the flow canvas armed the brake** (§5f) — stale since v3; it is armed
  from `lib/use-agent.ts`. Found by re-running the extraction script instead of editing from memory,
  which is exactly what that step in the `minami-kb` procedure is for.
- **Teams shipped** (§15) — team templates, and a task that runs *through* a team rather than inside
  one chat. Three templates as data (`tech-product` default, `solo-founder`, `content-studio`); each
  role becomes a standing agent at `~/brains/<role>`, shared box-wide so craft compounds across
  products. A run is one stage per role — separate session, separate folder, own memory and skills —
  all appending to one `dossier.md`, and every stage goes through `assign()` so the workspace check,
  the History-tab attribution and the agent's write-back come for free. Every template puts the same
  role at both ends of the chain: whoever writes the acceptance criteria is who checks against them,
  because splitting those makes the check degrade into "does this look finished", which always passes.
  Filing the record is folded into that closing stage rather than given to a separate Librarian —
  cheaper, and the known cost (no cross-product duplicate detection) is recorded in §15.2 so it's
  recognisable if the record starts drifting. Behind the existing Agent view toggle: with it off,
  nothing about the board changes. New `bin/team.mjs`, named by the marker-bounded team block the
  product writes into its workspace's `CLAUDE.md` — which is what makes the team reachable from a bare
  `claude` in that folder, with no dependency on this app running.
- **An unattended task was reaped as an orphan while it was still running** (§14.3) — `reapOrphans()`
  treated *module load* as *process start*, which `next dev` breaks by re-evaluating a module whenever
  a new route compiles. Now stamped with `process.pid` and reaped only when the pid isn't ours.
  Production was never affected; what it cost was the ability to test the agents layer anywhere except
  a production build. Post-mortem in §14.3.
- **Verified end-to-end 2026-07-31** — a full six-stage `tech-product` run against a production build,
  with every path (agents, products, runs, records) pointed at temp dirs: six sections appended in
  order under their exact headings, both halves of each agent's write-back landing, and the record
  filed into `decisions/ specs/ uat/ log.md` with `00-index.md` written last. The closing UAT stage
  returned **FAIL** on one of the criteria the opening stage had written — the bookend doing the job
  it exists for rather than rubber-stamping its own run.
- **Open-source readiness pass** — the repo had been public for weeks with no licence at all, which
  under default copyright makes a public clone readable and nothing else. Added `LICENSE` (MIT),
  corrected `package.json` (`UNLICENSED` → `MIT`, kept `private: true` as an npm-publish guard) and
  the README/CONTRIBUTING notes that claimed all rights reserved. Traced the `public/icons/` set to
  [3dicons](https://3dicons.co) — **CC0**, so no attribution obligation and nothing to swap; credited
  it anyway and dropped the earlier "check this before shipping commercially" warning, which was
  wrong. Added `engines.node >= 18.18` + `.nvmrc` (the supported version was documented in prose but
  never machine-enforced), a `@hono/node-server` override clearing 2 moderate advisories, and a
  GitHub Actions build workflow. No lint or test job: there is no eslint config and no test files, so
  both would pass vacuously — see `.github/workflows/build.yml` for why that's deliberate.
- **`npm install` breaks the build on the author's box** (§8) — `NODE_ENV=production` + `omit=dev`
  prune `typescript`, which silently disables `tsconfig` path aliases. Post-mortem in §8.
- **Continuing a chat failed with "No conversation found with session ID"** (§1) — `foldLine` took a
  session's *last* recorded `cwd`, so any session that `cd`'d mid-run reported a subdirectory as its
  cwd; `--resume` is scoped to the launch directory the transcript is filed under, so the CLI hunted in
  the wrong `~/.claude/projects/` dir and errored. Froze `meta.cwd` on the first `cwd` row + added
  `PARSE_VERSION` to force one reparse of already-drifted cache entries. Also hardened `app/page.tsx` to
  resume an existing pane in that session's own cwd, not the topic's aggregate. 11/374 sessions were
  affected. *Reported by user: "fix minami dashboard where it return: Claude Code returned an error
  result: No con…"*
- **The worktree occupancy guard had never once run** (§9) — `bin/task.mjs` tested session cwds against
  worktree paths, but nothing ever puts a session in a worktree, so `merge`'s `agent-live` refusal and
  autopilot's `t.live === false` gate were both unreachable and autopilot deleted trees agents were
  writing in. New `lib/worktree-claim.ts` adds a heartbeat claim file inside each tree; occupancy is
  now claim ∨ live-cwd, so it survives a server restart and works with the dashboard down. `cmdRm` had
  no occupancy check at all and now has one. QA found two more before shipping: the claim file made
  every claimed tree read as dirty (now gitignored), and `worktreeOf` resolved symlinks inconsistently
  depending on whether the leaf existed, failing toward "unoccupied".
  *Asked by user: "need a better way for the autopilot agent to assign chats or session with correct
  worktree so no conflicts happens in the future, then audit and QA it".*
- **A chat keeps its name, its window, and its way back** (§1, §5d) — one report, four independent
  causes, all reproduced against the running server before anything was touched. **Renaming:** `title`
  preferred `lastPrompt`, and the CLI appends a `last-prompt` row on every message, so every tile and
  tab renamed itself each turn (measured: eight successive titles for one session). It now freezes on
  `titleSeed`, the first message that actually names a topic — chats open on "yes" or a
  `<local-command…>` echo often enough that the literal first prompt is not it.
  `META_DERIVATION_VERSION` makes the change reach already-cached sessions at no file-I/O cost;
  `migrateAccum` settles and latches the seed for accumulators that predate the field. **Closing:**
  Escape was checked *above* the input/textarea guard, so pressing it in the composer — or to dismiss
  an IME candidate list, which is what it does on a Vietnamese keyboard — tore down the panel and
  cleared the persisted `openPanel`; `proj` was resolved out of the *filtered* project list, so typing
  in Search unmounted the open conversation mid-turn; and a failed `/api/bento/sessions` poll was read
  as an empty board. **Losing history:** `newTopic` was never retired once its folder became a real
  project, leaving a panel with an empty session list and no route back to the chat it had just
  started. *Reported by user: "new chat … keeps changing topic title, close on its own and lose the
  history".*
- **A running tab is legible now** (§5e) — an unfocused pane is `display:none`, so its tab is the only
  place a background turn can announce itself, and all it had was a 6px sakura dot on `animate-pulse`.
  Fading a 6px dot is the wrong channel (at the dim end it looks static), the tab around it stayed
  `text-neutral-500` (reads as disabled), and the signal was binary though `liveAct` has carried
  `phase` all along. Now: an expanding ring (`.tab-live-ring`, edge motion beats brightness for
  peripheral vision), a phase-tinted border and wash on the whole tab, and colour that names the
  phase. The dot slot always renders — mounting it on the first busy frame shifted the label 12px on
  the tab you were about to click. `awaiting` stays loud and still, per `.activity-idle`. Focused tabs
  keep sakura, and the ring is in the reduced-motion kill list.
  *Asked by user: "need clearer indicator for tabs that's running: animation/color visual clues etc".*
- **`paneAct` closes the pre-session-id gap** (§5e) — `liveAct` is keyed by session id, which a blank
  chat lacks for the first second or two of its first turn, so the pane you'd just sent to showed
  nothing. `ChatColumn` now reports its own SSE phase via `onBusy`, read **only** where `liveAct` has
  no entry, so the server stays the single source of truth. Verified by sampling the DOM across a
  spawn: ring and tint up while the tab still said "New chat", then `liveAct` takes over seamlessly.
- **No personal identity ships in the repo** (§6) — `preferred-account.ts` hardcoded the author's
  email as the built-in fallback, so a stranger's first run raised a permanent wrong-account alert
  against an address they can't log into. Fallback is now empty and `offPreferred` is guarded on it,
  making the check dormant until you choose an account; `PreferredAccountPanel` grew a third state so
  "nothing chosen" stops reading as "all clear". No behaviour change for the author — the real choice
  was always in `~/.minami/account.json`, outside the repo.
  *Asked by user: "I saw lots of hardcodes — audit to change them all back to dynamic variable that I
  can share this repo as opensource".*
- **`.env.example` documents all 29 env vars** — 24 were undocumented, so another user's Claude Code
  had no way to know what was configurable. Each entry now names its built-in default. Verified both
  directions: nothing read by the app is missing, nothing documented is unused.
- **Two stragglers made dynamic** — `bin/task.mjs` hardcoded `localhost:3000` for its live-agent
  check (a dashboard on another port reported "no live agents", indistinguishable from the truth, on
  the check that stops you deleting an occupied worktree); and `lib/bento-enrich.ts` held a literal
  `claude-haiku-4-5` against the "model ids only in `lib/model-pins.ts`" rule — now `CHEAP_MODEL`,
  overridable via `MINAMI_CHEAP_MODEL`, deliberately not falling through to the pin.
- **No real account addresses anywhere in the repo** (§6) — the author's two Gmail addresses appeared
  in ~12 places across code comments, the knowledge record and the KB pages, always as worked examples
  ("state.json said X while the keychain said Y"). In a public repo that publishes personal addresses
  and tells a reader nothing. Replaced with `preferred@example.com` / `other@example.com`, which are
  self-documenting — they name the *role* the account played in the incident, which is the part that
  carries the lesson. Quoted user reports are redacted to `[account]` rather than rewritten, so no
  quote claims words that weren't said. The `github.com/pdtoan2811-bit/...` clone URLs stay: that's
  the repository's actual address, not a per-user value.
- **A dead Claude account reported `READY` for ten hours** (§6) — post-mortem recorded; `tok status`
  derives that from `needs_reauth`, written at add-time and never revised when a refresh fails.
  `tok sync` flips it to `REAUTH`. Diagnosis only; recovery needs an interactive login.
  *Reported by user: "check why [account] got Failed to authenticate ... since everything is alright".*

### 2026-07-30
- **Settings' toggle was being squashed by its own description** (§5e) — `Toggle` lacked the `shrink-0`
  that `Segmented` got when the same bug hit it, so as a flex item opposite a long description it
  shrank: Agent view's track rendered 25.4px instead of 44px, and because the knob is absolutely
  positioned at a fixed 20px, what was left read as a bare circle rather than a switch. It toggled
  correctly the whole time, which is why it survived every functional check.
  *Reported by user: "the agent toggle in the setting still error - the toggle is broken, not a normal
  toggle".*
- **Five-round audit of the agents view; 18 findings, 14 fixed** (§14, §5e) — run as five MECE passes:
  view-state plumbing, registry CRUD, scaffold/adopt, the task runner, and attribution/UI. The three
  that mattered: a **setting toggle that did nothing until you reloaded** (`useSetting` had no
  cross-component subscription — a class bug, not one toggle), **Stop reporting a run as `done`** and
  re-sending the wrap-up into the session it had just interrupted, and the **chat pane opening
  scrolled to the top** so the onboarding interview's question card sat below the fold under a
  "waiting on your answer" header. Also: dead `/?session=` links replaced with a real transcript
  viewer, adoption no longer imposing a vault structure on a code repo, two agents no longer able to
  share one home, config input rejected rather than coerced, corrupt state reported rather than
  silently emptied, and the roster's N+1 poll collapsed to one request.
  *Reported by user: "I already found bug on the setting toggle omg".*
- **Second audit pass** (§14) — handoff chains verified end to end for the first time (Alpha's result
  reached Beta as a standalone brief and Beta acted on it), traversal probes on every id parameter came
  back clean, and the rewritten settings hook survived rapid toggling, corrupt stored values and
  foreign storage events. One new defect found and fixed: **every finished task was titled "That run
  is finished…"** on both the transcript viewer and the main board, because a transcript takes its
  title from the last user prompt and the wrap-up is always last. The wrap-up now leads with the task
  title.
- **Duplicate reply while a turn is parked** (§3, §14) — attaching to a session waiting on a question
  rendered the assistant's message twice, because the in-flight message is already on disk while
  `partial` still holds it. Pre-existing in `lib/use-agent.ts`; the interview made it the normal case.
- **Standing agents shipped** (§14) — a new opt-in view (Settings → Agents) where an agent is an
  identity plus a *home folder* it thinks and remembers in, separate from the workspaces it does work
  in. Create scaffolds a brain or adopts an existing one (`~/secondBrain` inherits its 33 sessions as
  history on day one); an onboarding interview runs as a real session and writes the folder from your
  answers. Unattended tasks, handoff chains, per-agent model and permission mode, and an HQ tile that
  delegates via `bin/agent.mjs`. Verified end-to-end against a scratch registry, not just built.
- **Agent history was empty for work just completed** (§14.1) — the CLI records the *resolved* cwd in
  its transcript, but the registry stored the path as typed; on macOS `/tmp` → `/private/tmp` made the
  two encode to different project directories, so the lookup found nothing and reported it as "no
  sessions". The store now resolves through `realpathSync` on every read.
- **`sendMessage` accepts an optional `model`** (§3, §14.1) — applied once at `ensureSession`, so each
  agent can pin its own tier. Omitted everywhere else, which keeps the box pin in force. The picker's
  list lives in the new `lib/model-catalog.ts`, re-exported from `lib/model-pins.ts` so ids still have
  exactly one home.
- **`listSessionsIn(cwds)` added to the transcript parser** (§1, §14.4) — a directory-scoped scan, as
  opposed to `listSessions()`'s box-wide recency window, so an agent's history doesn't disappear when
  its folder goes quiet for a fortnight.
- **Chat tabs close like browser tabs** (§5e) — ✕ on the tab (always on the active one, on hover
  otherwise, width always reserved so the label can't slide out from under the cursor), middle-click,
  ⌥W to close and ⌥⇧T to reopen the last one at its original index. Not ⌘W/⌘⇧T: Chrome keeps those. The
  tab became a `div` around two buttons, since a nested button is dropped by the browser and the ✕ would
  have selected the tab. Closing is a view action — the session keeps running and stays on the board —
  and the last tab closes the panel. Fixed alongside: closing a tab **left of** the active one shifted
  the panel onto a different conversation, because the clamp knew the array had shrunk but not which end
  lost an element. All three close paths now route through one `closePane(i)`.
  *Asked by user: "need a way to easily close tab - like browser experience but for chat".*
- **One control language, one theme** (§5e) — a UI-refinement pass over all four surfaces. Nine
  hand-rolled copies of the same segmented control (bento window + sort, composer Plan/Code +
  approval, both again in Settings, Nav, heatmap range) collapsed onto `components/ui/Segmented.tsx`,
  which also fixes `auto-edits` wrapping mid-word in Settings. `<html className="dark">` commits the
  app to one theme — `/dashboard` was the only surface with `dark:` variants, so on an OS preferring
  light it rendered light with a near-invisible `Nav` while every page one click away was dark; 38
  `light dark:X` pairs across ten files collapsed to `X`. Fixed: tile stats running under the FLOW
  switch (`pr-14` plus container-width drops, since `shrink-0` spans overflowed the padding at rail
  width); five stacked `CLAUDE` headers on one reply (`sameSpeaker`, with a density-aware inline
  pull-up because `space-y-*` outranks any child class); the live activity line rendering twice ~40px
  apart. `/dashboard`'s four identical empty panels became one `Personal panels` card, and its model
  grid is tied to `MODELS.length` so Fable 5 stops orphaning onto its own row.
  *Asked by user: "I want to refine all of the clunky UI component so Minami dashboard is lean but
  still keep the aesthetic".*
- **`CLAUDE.md` works in a fresh clone, and `minami-kb` ships with the repo** (§7b) — the file Claude
  auto-loads described only this machine: it addressed Thomas by name, assumed "you are running inside
  a dashboard chat pane", pointed at `~/.minami/deploy.log` and `Redeploy Minami.command`, cited the
  `minami-kb` skill that lived only in `~/.claude/skills/`, and never said `npm run dev`. Now two parts
  with a `test -d ~/.minami` check at the top: Part 1 (any clone) carries running it, `build:check`, the
  three pipelines, conventions and the record; Part 2 is fenced as the author's box only. `minami-kb`
  added to `.claude/skills/` with repo-relative paths and its vault/`minami-sync` references dropped.
  *Asked by user: "get me a document so it can integrate with anyone pulling minami-dashboard repo
  using claude - where claude can find it".*
- **The add-chat menu's first row was unclickable** (§5e) — the `＋` dropdown sits inside
  `group/chrome`, so reaching for it unfurled the header peek, which at equal `z-20` and later DOM order
  covered the menu's top 57px. Menu raised to `z-30`, peek suppressed while the menu is open, backdrop
  to `z-20`. Verified `overlapPx` 57 → 0 with the peek still working when closed.
  *Reported by user: "add chat popup dropdown hidden by the hover effect".*
- **The ask card's "Other" answer could be typed but not sent** (§5e) — typing selected the Other row,
  but clicking that row ran the plain toggle and deselected it, stranding the typed text on screen
  behind a disabled Send; focus still chased the row the click had switched off, so it read as a dead
  button. The Other row now selects-and-never-deselects while it holds text, and focus only follows a
  click that leaves it on. Matters beyond annoyance: a stranded ask card holds the pane at
  `phase=awaiting`, which starves any deploy waiting for quiet (§8). Multi-select also de-dupes now.
  *Reported by user: "cant send the other text detail answer option".*
- **The knowledge record is an index over `docs/knowledge/`** — it had reached 2,507 lines / ~46k tokens,
  so opening it cost about a quarter of a session's context to answer a question about one module, and
  the rational move became not reading it. Split at `##` boundaries into 16 per-subsystem files plus this
  changelog; `KNOWLEDGE.md` is now a ~2.4k-token index carrying the data-flow diagram, the subsystem
  status table, the directory, and "the pattern behind the incidents" (promoted out of a subsection,
  since it is the one lesson that generalises across every post-mortem). Section ids were deliberately
  **not** renumbered — ~25 code comments, `bin/deploy.sh` and two skills cite `§5e`/`§8`/`§12`, and the
  directory is the one hop from an id to its file. The single exception: Autopilot was a duplicate `## 12`
  and became `§13`, with its one citation fixed. Verified by diffing every `###` heading (77, identical)
  and every content line (4 differences, all intended rewrites).
  *Asked by user: "knowledge.md is incredibly long and takes up context — should we approach it by a more
  comprehensive length, showing directory to other docs?"*

- **Preferred account is now chosen in Settings** (§6) — new `lib/preferred-account.ts` persists it to
  `~/.minami/account.json`, `GET /api/accounts` reads it per-request, and a new `PUT` sets it.
  `components/PreferredAccountPanel.tsx` adds the Account section. It had been a module-level
  constant defaulting to an account which `tok setup` later deleted from the pool — so the
  header alert was firing on every healthy session, comparing the live credential against an account
  that no longer existed. `PUT` is separate from `POST` because `POST` rewrites the Keychain and kills
  running sessions; choosing a target must not do that. Verified live on :3001 — valid write pins and
  flips `offPreferred`, a non-pool address and an empty body both 400 and leave the file untouched.
  *Reported by user: "set the minami dashboard email token cli to [account]" → "change the
  minami dashboard so I can switch it inside the setting"*
- **The flow strip stops being a row** (§5e, §5f) — it is a chip on the control row at every density
  tier, next to Plan/Code and the approval chips, and the full-width variant is deleted. It cost ~42px
  of every pane permanently: the wide form folded to a chip only when cramped, which was fine while the
  2×2 grid was the default and the wide form was therefore rare, but tabs-first made every pane you read
  `roomy`, so "sometimes" became "always". The running step's title moves to the tooltip — the activity
  line at the other end of the same row already says it — and the chip tints while a step is running.
  *Reported by user: "the flow section is still there taking extra space".*
- **Task preview ports can no longer collide** (§9) — `portFor()` hashed a name to one of 40 slots with
  no collision check, under a comment promising there'd be no collision; `bell-anchor` and
  `resume-audit2` were both on :3024. The hash now picks a preferred slot, clashes probe forward in
  sorted-name order (so ports depend on the *set* of tasks, never on call order), and the span is 90.
  Found while pruning merged worktrees.
- **Panel compaction: four cuts that tab view made possible** (§5e) — the auto-rail heuristic no longer
  fires in tab view (it counted chats *open*, not *visible*, so opening a 4-chat topic threw the bento
  board away for panes that were never on screen); the hover-reveal header moved **below** the tab row
  and went `absolute`, so revealing it no longer displaces the tab you're aiming at (measured: tab row
  `top: 0` with and without hover); the per-pane title collapsed to a bare `⌄` when it merely restates
  the lit tab; and the transcript caps its **measure** at `max-w-3xl` on the children, so a maximised
  chat centres to a readable column while the scrollbar stays at the pane edge.
  *Reported by user: "it automatically open the bento strip view", "the hovering title ... shift the tab
  navigation down", "chat log in full focus view ... should be centered", "need more compact UI UX".*
- **The chat panel is tab-first, and the side slot is tabbed throughout** (§5e, §5b, §5g, new
  `components/PanelTabs.tsx`) — tabs replace the 2×2 grid as the default view, with one view switch for
  the panel instead of a maximise button on every pane; the identity header (name · repo · tech icons ·
  counts) collapses to nothing and slides back on hover, keyboard focus or a pin; grid view tightened to
  `gap-1 p-1` since showing all four at once is the whole reason to use it. The file preview's 144px
  vertical rail and its `<select>` stand-in below 340px both became one shared tab row, and the browser
  panel now wears the same header · tabs · content shape with the page as one tab among Page · Console ·
  Network · Actions — its drawer's `max-h-32` strip becomes the full content area. Caught in
  verification: porting the console badge's "ask the agent" click onto the Console *tab* made a tab
  silently start a turn in a live session; tabs navigate and nothing else now.
  *Requested by user: "Tab navigation as default please, with button to switch view rather than the full
  screen button … also can hide and hover to show the header … files also need tab navigation instead of
  menus and browser need to match the files preview layout".*
- **Messages can be queued mid-turn** (§5f-bis) — typing into a busy pane no longer drops the message;
  the CLI queues it and runs it as its own turn. Streaming-input mode already supported this at the
  transport level (`streamInput` writes straight through without waiting for the turn), so the work was
  splitting `sendMessage`'s turn-start bookkeeping from its enqueue path — running it mid-turn had been
  truncating the in-flight reply's `partial` buffer and wiping `liveTools`. Queue state comes from the
  CLI's undocumented `command_lifecycle` channel, keyed by a uuid we now stamp on every outgoing message.
  Stop keeps its meaning of "abandon this turn" but lets the queue proceed, which makes a mid-flight
  correction one gesture. Verified end-to-end: queue-then-run, Stop-then-run-queued, and a two-deep
  queue draining in order through the UI.
  *Requested by user: "I want to add queue message mechanism".*
- **The flow screen hides the rest of the bento** (§5f, v3.1) — it used to expand one tile and reflow the
  others around it, so the grid stayed on screen competing with the graph. Now every other tile,
  Autopilot and "New topic" are unmounted while flow is open, and the grid becomes a single full-height
  cell so the canvas gets the whole column. Because that leaves the canvas's ✕ as the only control on
  screen, Escape also closes it, and the flow self-closes if the search box filters its project away.
  *Requested by user: "dont show other bento tiles in the screen where is the flow screen is open".*
- **Density tiers + the SHE revamp of the chat pane** (§5e, new `lib/density.ts`) — at four panes,
  chrome was ~200px of a ~354px column and the transcript got 146px, about three lines. Panes now
  measure themselves (`ResizeObserver`, both axes, +28px hysteresis on the way back up) and shed chrome
  by tier: the goal subtitle goes, the flow strip and the six mode controls merge into one 22px bar with
  a `code · bypass` pill, padding tightens, and at `micro` the bar itself goes. Focusing the composer
  buys a tier back, so the real Plan/Code and approval controls return exactly when you're about to
  send. `⌥1–4` gives one pane the whole panel with the rest as a tab strip (`display:none`, never
  unmounted — with scrollTop saved and restored by hand, since a hidden box loses it); `Esc` steps out
  of focus before it closes the panel. The side slot won't open below `snug`, and 3+ panes auto-rails
  the bento once. Measured after: transcript 146px → ~232px. Verified in a preview build at 1455×820 and
  1000×620, four panes.
  *Prompted by user: "the chat panel is really crowded with small area for agents when it comes to 3 or
  4 … apply SHE — simplicity, Hide, Embody".*
- **Self-audit of the flow canvas** (§5f) — found and fixed two features that could never fire (the
  held-state rendering behind a hardcoded `null`, and a `busy` flag derived from a field the on-disk
  transcript never sets), plus a 3s poll of finished sessions, an empty-session-id path, and arbitrary
  initial framing. All five came from splicing v1's source into a component with different data
  guarantees; all five type-checked and built.
  *Prompted by user: "audit them again and revise yourself to see if you slopped".*
- **The notification bell no longer moves with the bento** (§10) — it lived in the bento header with
  `ml-auto`, so opening a project slid it 770 px left (x=992 → x=222) and collapsing to a rail removed
  it entirely. Now one viewport-fixed mount at the top-right corner: same coordinates in all three
  states, and reachable in rail mode for the first time. Both headers reserve its gutter.
  *Reported by user: "need a better placement and position for notification since it shift accordingly
  to the bento size".*
- **Flow is a canvas in the bento column again** (§5f) — a `flow` switch on each tile expands that tile
  into the React Flow graph, full-width and three rows tall, with the other tiles reflowing around it
  via the `layout` animation they already had. The minimap and zoom controls stay gone; `fitView` with a
  `minZoom` floor replaces them. The in-chat list panel is retired in favour of the strip as a second
  door to the same canvas, and the brake moved to the composer's control row.
  *Reported by user: "I want to see flow on left side of the screen where bento UI is, by click a switch
  on the bento tiles to expand the bento dynamically to be the canvas for react flow".*
- **Every turn shape can now open its flow** (§5f) — the strip read raw `TodoWrite` while the panel
  used `buildFlow`, so `TaskCreate`-tracked and unplanned turns had a flow with no way in. One
  derivation now feeds both, the label tells the truth about whether Claude planned the turn or we
  grouped it, and the strip holds its place while a turn is running. `TodoChecklist` retired — the
  strip is its collapsed state.
  *Reported by user: "how to find it?"*
- **Flow rebuilt as a disclosure in the chat, not a view mode** (§5f) — the React Flow canvas, the
  per-project view preference, the ⚙ picker on the tile, `lib/view-prefs.ts` and `/api/bento/view` are
  all gone. The plan strip above the composer is now the way in, steps group by status
  (running / up next / done) instead of drawing a twelve-node spine, tool calls group by what they did,
  and expanding pushes siblings the way the bento does — measured at 226px. No minimap, because there
  is no topology to explore.
  *Reported by user: "React flow show was awful … remove the map on the corner … hard to find the
  button … I believe I make a mistake when ideating the flow view … better way to group them steps
  semantically … people would love to click somewhere on each chat to see the flow".*
- **Autopilot has a face** (§5e) — a tile in the bento grid showing whether it's on, what it's doing,
  the last thing it did in plain words, and anything blocked; the switch is on the tile, and the full
  log of automated merges and deploys is one click away. `status()` gained `deploying` and
  `lastTickAt`. Also fixed: `next dev` had been returning **500 for every route** since Autopilot
  landed — the edge compilation of `instrumentation.ts` followed a runtime-guarded import into
  node-only code (§8).
  *Reported by user: "need an ui ux for that to let user know the task got automated with the merging
  and deploy — perhaps a special tile".*

### 2026-07-29
- **Autopilot: the always-on merge agent** (§12) — merges finished task worktrees, resolves mechanical
  conflicts with a verified-not-trusted agent pass, and deploys, so a non-technical user can iterate on
  several projects at once without ever asking for a merge. Off by default; switch on disk so it
  survives the restart it causes; crash recovery before the first tick; every failure path ends in
  `git merge --abort`. `task.mjs` grew `--json` on `list`/`merge` so the runner reuses the CLI's gates
  instead of re-deriving them.
  *Asked for by user: "an always on agent … to handle merging and resolve conflicts … non tech user
  like me wont need to ask minami dashboard to merge, deploy etc".*

### 2026-07-29
- **A handle on the seam itself, so switching views needs no prior knowledge** (§5e) — every existing
  route between board and strip was something you had to already know: drag a 6px divider to an
  invisible threshold, double-click that same strip, learn ⌘B, or recognise a header icon. The handle
  sits on the boundary between the two things it swaps, always visible (dim, brightening on approach)
  rather than hover-only — hover-only would have hidden it behind the very 6px target that was too
  small to find. Three details are load-bearing: `stopPropagation` on pointer-down and double-click
  (else a click also starts the parent's drag, and a double-click fires the parent's toggle a second
  time, undoing it); it unmounts mid-drag (it sits exactly where the cursor is); and `z-20` puts it
  *under* the rail's `z-30` hover overlay, so the expanded strip covers it instead of a chevron floating
  across the project chips — no state plumbed between components. It grows rightward from the seam
  rather than straddling it: centred, a 20px pill spanned 49–69px while the collapsed strip owns 0–56,
  clipping its left third. Verified in both modes — no clipping, centre clickable, no drag triggered,
  toggles both ways. Transitions only, never an animation (KNOWLEDGE.md §12).
- **Rail ⇄ grid is now one control with two states, plus ⌘B** (§5e) — it used to be a bare `⇤` glyph in
  the page header and a 🌸 logo in the rail: two glyphs, two locations, two metaphors, nothing saying
  they were the same idea. Both are now `PanelLeftClose`/`PanelLeftOpen` with the shortcut in the
  tooltip. At 56px the rail has room for exactly one control, so the mark *stays* the target (the
  affordance people already learned) but swaps to the panel glyph on hover — branding at rest, an
  obvious control on approach. ⌘B is guarded against the composer: this app's primary input is a
  textarea and ⌘B is bold muscle memory, so it must never fire while you're writing. Verified all three
  paths, including that one.
- **Rail icons were 4px off-centre** (§5e) — `gap-2` applied between the icon and the name span, which
  stays mounted at width 0 while collapsed (deliberately — mounting it on hover reflows the row). A
  flex gap is applied between items regardless of whether one has width, so 8px of gap sat between the
  icon and nothing and displaced it by half. `justify-center` couldn't help: it was faithfully centring
  "icon + gap + nothing". Gap is now conditional on the names being out. Measured -4.0px → **0.00px**
  on every chip. *Reported by user: "the icon on the bento strip is not 100% centered".*
- **Idle panes now unpin their session, visible or not** (§3) — third perf pass. Measured first: with
  the animation and hidden-tab fixes in, the client is already at **60 fps, 0 long tasks, 0% main
  thread, 30 MB heap** with 4 panes open, endpoints answer in 1-10 ms, 108 req/min costs ~0.4% of a
  core, and first load is TTFB 2 ms / FCP 124 ms. None of that was worth touching. The one bad number
  was **71 MB free RAM**, with a single *visible but idle* pane holding 388 MB. Unpin now triggers on
  inactivity (5 min, or 1 min when also hidden) rather than on hiding, and any pointer/key event
  re-attaches. Verified end-to-end: 364 MB returned with the tab still visible and untouched.
  *Requested by user: "optimize the app to get even more performance optimized".*
- **Deploy and server logs moved out of `/tmp` to `~/.minami/`** (§8) — macOS clears `/tmp` on boot. A
  reboot at 21:57 took `minami-deploy.log` and `minami-prod.log` with it, while `~/.minami/events.jsonl`
  survived the same instant. A deploy is the one operation whose requester is dead before the outcome
  exists, so its log is a *sole witness*; `serve.sh`'s log is what `deploy.sh` quotes into the failure
  alert, so losing it degrades that alert to "it failed" with no reason. Overridable via `DEPLOY_LOG` /
  `PROD_LOG`.
- **Correction: the swap/paging recovery credited to the pane-memory fix was a reboot.** `vm.swapusage`
  and the swapin/swapout counters are zeroed at boot, so "swap fully reclaimed, paging stopped" read a
  reboot's effect. `288e6ba` is deployed but its effect is **unmeasured** — the baseline was wiped.
  Re-measure over a long uptime before claiming it works. High load right after a reboot is usually
  `mds`/`mdworker_shared` reindexing (~190% CPU here), not the dashboard.
- **Idle animation cost cut to the floor: a pulse now means "happening now"** (§12) — second perf
  audit. Measured that animation cost is a **fixed per-frame tax**, not per-element: 0 animated
  elements = 1.3% CPU, 1 = 12.6%, 41 = 17.1%. So one permanently pulsing dot costs what forty do — and
  the tile's `review` badge (a standing state, not an event) plus `spin3d`'s 2-minute `p.active` window
  meant the page never reached zero animations. Both now key off a turn actually in flight. Verified:
  zero animations at idle where there were always ≥1 before. Also ruled out by experiment — server cost
  is 0.17%/pane across ~190 req/min, and React re-render from polls is ~2 points; `will-change` does
  nothing (tested twice). *Requested by user: "audit for more optimization … with surgeon knife and
  clear approaches and hypothesis".*
- **A hidden tab now gives its panes' memory back** (§3) — each live pane pins a ~330–410 MB `claude`
  subprocess, and the idle reaper only ever armed at zero subscribers, so an open tab reclaimed nothing.
  Panes hidden for 10 min release their stream and hand the session to the existing reaper. Found while
  auditing machine heat: the dashboard's CPU is negligible (~3% server, 0% page main thread) — the cost
  was memory, on a 16 GB box down to 81 MB free with 6 GB swapped.
  *Requested by user: "audit the heat problem running Minami dashboard".*
- **The dashboard was burning ~31% of a CPU core while idle** (§12) — reported as "lag and heat".
  Not the polling, parser or SDK (`next-server` measured 1.5%): it was `backdrop-filter` re-blurring a
  whole tile / the 768×800 chat panel every frame because a 1.5px indicator dot was animating inside
  it. Same animations cost 30.6% with the blur and 4.6% without — a 6.6× multiplier — and the blur was
  visually inert, since behind it was a flat colour and a smooth gradient. Removed from both
  containers, moved `drop-shadow` off the rotating icon, and added `prefers-reduced-motion`. Measured
  A/B in the same page and process: **GPU 31.1% → 14.0%**. Layer promotion was tried and rejected
  (33.8% → 33.2%, inside noise). *Reported by user: "lag and heat on my local machine".*
- **Audit of continue-on-open — four defects fixed, and the feature actually exercised** (§5e). The
  candidate is now scoped to `s.cwd === cwd` (a topic is keyed on `basename(cwd)`, so same-named folders
  share one); the two-writers guard claims the id at spawn instead of at `init`, closing a 1–2s window
  where two panes could both pass it; a refused resume now hands the id back through `onLive("")`, since
  undoing it locally left the parent still latched; and the copy no longer claims "where you left off"
  when the date-window chip may have hidden something newer. Verified on the preview rather than by
  inspection: a resumed pane answered a question only the earlier conversation could answer
  (`cat probe.txt`), the chat count stayed at 7 so nothing forked, and two concurrent rival resumes of
  the same not-yet-live session ended with exactly one accepted.
  *Requested by user: "audit the resume automation".*
- **Blank chat panes continue the topic's last conversation** (§5e) — `claude --continue` parity. A
  blank pane used to start a session that could see none of the project's history. It now names the
  chat it will pick up before you type (with `Start fresh instead`), draws a seam in the transcript
  once it has, and refuses to resume an id that's live in another pane — two subprocesses appending to
  one JSONL corrupts it in a way no reconcile can undo.
  *Requested by user: "auto resume session like in claude cli for consistent context and chat".*
- **Paste an image straight into the composer** (§11) — `lib/agent/images.ts`, `app/api/fs/paste`,
  `app/api/fs/image`. The payload is a **path**, not bytes, which preserves the composer's
  single-source-of-truth invariant and gives the attach button thumbnails and inlining for free. An
  inline image block alone would have been a bug: `claude-sessions.ts` keeps only text blocks when it
  rebuilds a user turn, so the image would render live and vanish on the next reload. Verified: 64×64
  PNG round-trip byte-identical, renamed `.env.local` rejected on magic bytes, traversal rejected,
  plain-text paste untouched, quoted paths with spaces matched. *Asked for by user: "I want to copy
  and paste image straight to the chat panel input".*
- **`task.mjs new` branches from committed HEAD, so a dirty base yields a stale worktree** — recorded
  in the `minami-flow` skill. With 47 uncommitted files in the base, a fresh worktree was missing that
  day's entire body of work. A worktree built on a stale base is worse than none: it looks correct.
- **The `:focus-visible` ring stopped painting a pink rectangle on the composer** (§5e) — a regression
  from the interaction pass below, caught the same day. `:focus-visible` matches a text field on a
  plain mouse click, and the ring being *unlayered* beat the composer's `outline-none` in
  `@layer utilities` regardless of `:where()`'s zero specificity. Text fields are now out of the
  selector; `border-radius: inherit` went with it.
  *Reported by user: "when I click on chat panel - a pink rectangle show up".*
- **The empty composer stopped sizing itself to its placeholder** (§5e) — `scrollHeight` on an empty
  textarea measures the wrapped placeholder, so idle inputs in narrow panes ballooned to three lines
  (68px → 23px after the fix). Wrapped inline-code chips also no longer render as one box torn in half
  (`box-decoration-break: clone`, in both the composer's tint layer and the message renderer).
  *Reported by user: "weird box wrap in chat input".*
- **Front-end interaction pass** (§5e) — one motion vocabulary (4 durations, 2 curves, Tailwind's
  defaults retuned to match), `transition-all` eliminated tree-wide, `prefers-reduced-motion` and
  `:focus-visible` honoured for the first time, pin-aware chat scroll with a "jump to latest" return
  path, the browser splitter taken off React/localStorage per pixel, and `TurnRow` memoised (12
  scroll-driven state changes: 20 row renders instead of ~900).
  *Reported by user: "code refactor on front end for snap and smooth interaction — matching the open
  source standard".*
- **Permission modes are real now, and bypass is the default** (§3) — the composer's pills changed
  nothing on an already-running session while reporting success; the mode is now enforced by the
  server's own `canUseTool` and the route answers honestly. `bypassPermissions` is the shipped default
  for this box (`MINAMI_DASHBOARD_PERMISSION_MODE` to override), exposed in Settings → Chat.
  *Reported by user: "set bypass permission as default across the minami board - check if the
  permission pill click are actually effective".*
- **`minami-flow` skill: when to isolate, merge, deploy and resolve conflicts** —
  `.claude/skills/minami-flow/`, with a read-only `orient.sh` preflight. CLAUDE.md is thin and shaped
  for prohibitions; KNOWLEDGE.md holds the reasoning but nothing reads a reference doc unprompted.
  The missing piece was *judgment at the two moments it's needed* — before the first edit, and before
  shipping. Built on the observation that **state in this repo is invisible from inside a pane**: every
  collision so far was found by accident (a file changing under an open editor, a lock refusing a
  command, a deploy timing out), and all were one command away. Gates are commands with a pass/fail,
  not judgment calls; every failure path is an action, and the single escalation point is a *semantic*
  merge conflict. *Asked for by user: "need a skill … to know when to do those things".*
- **A deploy can starve on a pane blocked at a permission prompt** (§8 🐛) — quiet is box-wide, and
  `phase=awaiting` never clears itself. Found live while writing the skill.
- **Out-of-pane alerts: deploys, worktree builds and merges now reach you** (§10) — a disk-backed
  event log (`bin/minami-event.mjs` → `~/.minami/events.jsonl`) plus a bell in the header carrying the
  real bodies (the verify table, the `tsc` error). The existing `notify()` path only covers events
  produced *inside a React tree* and is transient by design, so a detached deploy could only ever
  report itself into a log nobody was tailing. A file is the only transport that survives the deploy
  that produces it. *Asked for by user: "get me a notification … when there is updates on worktrees
  waiting to be go up to production, build success etc".*
- **Every deploy was reporting "verification FAILED" while serving perfectly** (§10) — a stale ambient
  `DEPLOY_PROBES` pinned `/api/fs/mkdir` to 400, but a POST-only route answers 405 to a GET. The probe
  defaults now live in `deploy.sh`, where they move with the routes they describe.
- **The ask card stopped lying about what it would send** (§5e) — "Other" is now a row in the option
  list rather than a separate input, so exactly one thing is highlighted and it is the thing that gets
  sent; single-select used to keep the chip and silently discard the typed text. Multi-select is
  declared in words and in the control's shape (checkbox vs radio) instead of a 10px footer hint, and
  options are strictly one per row — the wrapped chip layout reordered itself at narrow widths.
  *Reported by user: "I chose one above, it highlight and I can also input on the other option" +
  "sometimes multiple choice option is available but I have no way to know" + "The option need to be
  strictly vertical".*
- **Task isolation: one worktree, one branch, one agent** (§9) — `bin/task.mjs new/list/preview/merge/rm`.
  Two chats on one project shared a working tree and overwrote each other silently; the transcripts show
  **5 overlapping pairs in a single day**. Verified: an edit in a task worktree leaves the base checkout
  untouched, and merge refuses on a dirty base, a dirty task, or a live agent.
  *Reported by user: "I ask 2 chats at the same time to fix or add changes to minami-dashboard".*
- **Deploys are now mutually exclusive** (§9) — there was no lock at all, and `next build` replaces
  `.next` in place under the live server. Atomic `mkdir` lock with stale-holder recovery, plus a
  pre-detach advisory check so the refusal reaches the caller instead of only the log.
- **Permission mode is per session, not global** (§5e) — it was one localStorage key for every pane
  while `changeMode()` applies per session on the server, so setting bypass in one chat flipped every
  other chat's badge, and the badge could describe a session other than the one executing.
  *Reported by user: "the session is not consistent by chat somehow".*
- **`useSetting` leaked values across keys** (§5e) — on a key change with nothing stored under the new
  key it kept the previous key's value, so switching to a chat with no saved draft showed the draft
  from the chat you just left. Now resets to the default. This is what made per-session keys viable.
- **Panes warn when they share a folder** (§9) — "N agents are live in this folder", from
  `/api/agent/live`, which already carried `cwd`.
- **The browser preview was blank for every named screenshot** (§5b) — `/api/agent/browser/file` only
  looked in `<cwd>/.playwright-mcp/`, but `browser_take_screenshot` with an explicit `filename` saves
  to the session root *and* omits the inline image, so the panel had no source at all. It now checks
  both locations under the same allowlist.
  *Reported by user: "the browser preview is showing nothing when Minami Dashboard use it".*
- **`npm run build:check`** (§8) — a verification build that targets `.next-verify` instead of
  overwriting `.next` under the live server, which is what had been leaving :3000 serving an unstyled,
  never-hydrating page. `CLAUDE.md` now forbids the bare build. `deploy.sh` route probes accept a list
  (`400|405`), so a POST-only route no longer fails an otherwise-good deploy.
- **Transcript history is reachable end to end** (§1) — turns are read as addressable *windows*
  instead of a fixed 1.5 MB tail + `slice(-120)`, and `/api/bento/session/[id]?before=<byteOffset>`
  serves the page before any offset. History pages are immutable, so each is read once and cached
  forever; the live tail is folded incrementally like meta. Verified by walking two real transcripts
  to offset 0: **863 turns in 6 pages** and **1813 turns in 11 pages / 0.6 s**, both matching an
  independent full parse exactly, no gaps or overlaps.
  *Reported by user: "the older history log transcript is not accessible for some chat or session —
  where it should show load old message".*
- **The "Show earlier messages" button no longer lies** (§1, §5e) — it revealed only already-fetched
  turns, then disappeared at the window edge as though the conversation started there. It now falls
  through to fetching from disk. Also fixed: the render `limit` never reset on session switch, so
  opening a short chat after expanding a long one rendered hundreds of messages at once.
- **The turns disk cache stopped being a hot-path cost** (§2) — was a synchronous 7.9 MB write on
  every reparse (i.e. every 2.5 s of a live session); now throttled to 15 s and budgeted by
  serialised bytes. **7.9 MB → 251 KB.**
- **`bin/transcript.mjs`** (§1) — read any transcript in full from the terminal, with the app down.
  `list` / `show`, with `--tail/--head/--since/--grep/--tools` and text · md · **JSONL** output for
  token-slayer and `jq`. 1813 turns out of a 64 MB file in 0.25 s.
- **Rail is a full-height weighted strip with hover-out names** (§5e) — chip heights are now a
  `log1p`-compressed share of the measured column height instead of three fixed sizes, so the strip is
  always exactly full and reads as relative weight; hovering slides the names out over the chat
  without moving it. Dragging the divider no longer routes through React (straight to `--lw`/`--rw`,
  committed on mouseup) and snaps to the rail on the frame it crosses 260px.
  *Reported by user: "clunky interaction for dragging like that - need refine to snap right away" +
  "I want the bento strip to be full vertical … with weight ratio of each bento scale accordingly" +
  "need a subtle hovering to show title for easier context switching".*
- **Topic icons actually distinguish topics** (§5e) — the `cube` catch-all is gone; icons are assigned
  across the whole visible set with collision fallback, the keyword table doubled, and
  `~/.minami-bento/icons.json` now carries a hand-assignable `icon` per project (the `bento-icons`
  skill documents it). Plus a `useSetting` setter-identity bug that was quietly discarding drag
  results.
- **One-command redeploy shipped** (§8) — `bin/deploy.sh` (wait-for-quiet → swap → verify, auto-detaches
  when its caller is a descendant of the server it's killing), the double-click
  `Redeploy Minami.command` for Finder, and `docs/DEPLOY.md` as the protocol. Success is now judged on a
  changed PID and `BUILD_ID` rather than exit 0 — the signal that lied in the §8 🐛.
  *Reported by user: "get me a .command file and a protocol that I can ask minami dashboard to redeploy."*
- **New topics can actually be created** (§5d) — three stacked bugs meant there was no working path from
  "＋ New topic" to a tile: the picker let you select a non-existent folder, `api/agent/send` never
  validated `cwd` (so the SDK spawn died silently, producing nothing at all), and `isTrivial`'s
  `messages < 3` hid the resulting session until its third message. Added `POST /api/fs/mkdir` plus a
  "Create this folder" / "＋ folder" affordance, a `cwd` stat check that returns a readable 400, and a
  freshness exemption so a just-made topic is always visible. Also fixed a new topic orphaning its own
  first conversation when reloaded within a second of the first send.
  *Reported by user: "I am having a chat in the second brain bento that should populate the topic
  ownegogrowth with it dedicated folder on my local machine — check why minami bento cant create such
  topic and fix."*
- **Reasoning is now typeset, not dumped** (§5c) — `Markdown` gained a `tone` (`chat` | `thought`) and
  a `caret` prop, so the thought block runs through the *same* parser as the answer, one contrast step
  back: paragraphs, lists and bold lead-ins survive instead of collapsing into one italic wall.
  `ThoughtBlock` moved out of `app/page.tsx` into its own component, and `manager.ts` now emits a
  `\n---\n` seam between thinking passes (new turn-scoped `sawThinking`) which the block renders as a
  numbered divider. Collapsed, the disclosure states its pass and word count.
  *Reported by user: "thought process print also need proper typography and divider of some sort to
  have better readability".*
- **Browser panel rebuilt** (§5b) — from a fixed 300px column showing the latest screenshot to an actual
  browser window: agent-driving toolbar (URL bar, back/forward/reload, device presets, record), status
  strip, screenshot filmstrip with a live/pinned split, console + network + actions drawer, drag-resize,
  side ↔ stacked layout, a pop-out window at `/browser/[id]`, and a real lightbox with zoom/pan and
  arrow-key stepping. All of it derived from tool results already on the wire — new `lib/browser-view.ts`
  is pure and shared by every surface. Three bugs recorded in §5b, including a "view full size" link
  that had **never** worked (Chrome blocks top-level `data:` URL navigation).
  *Reported by user: "I can click on to the browser preview to view it larger" + "matching the Claude
  Code browser UI UX and use cases".*
- **Claude Code parity, where it earns it** — researched the `claude` v2.1.220 binary: it has no browser
  panel at all, because it drives your real Chrome. So the *panel* is a deliberate divergence, while its
  permission prompt (verb phrase + host + session-scoped allow-all) and compact transcript arg summaries
  were ported. `--caps=devtools` added to the MCP spawn so video recording exists; a screenshot nudge
  added to the system prompt so the panel isn't blank while Claude reads accessibility trees.
- **KB page set complete** — `metrics.html` (6 sections) and `operations.html` (4 sections) shipped,
  finishing all five pages. Metrics records the `JSON.parse("null")` process crash, the absent
  retention policy, the two hand-synced price tables and the 2026-09-01 Sonnet pricing cliff.
  Operations is the runbook, and states the pattern behind nearly every incident here: a signal that
  looked authoritative but was only a claim.
- **UI corrected against the rendered original** — served `~/dataAnalyticsOwnego` and compared side by
  side rather than reading its CSS. Added the leading rule on section eyebrows, moved step narration
  above its diagram, and gave the hub its action card, metadata strip, card footer lines and centred
  closing line. One deliberate divergence kept: their sticky rail paints over full-bleed panels, ours
  doesn't.
- **KB navigation + light-mode default** — shared sticky top nav on every page via `KB.nav()`;
  `architecture.html` migrated off its duplicated inline CSS onto `kb.css`/`kb.js`; light is now the
  default theme with no `prefers-color-scheme` rule, matching dataAnalyticsOwnego's hub.
  `live-sessions.html` shipped (7 sections, 3 diagrams) — including the restart/drain mechanism and
  the drain-endpoint auth reasoning, neither of which was recorded here before.
  *Reported by user: "implement the navigation ... match 1-1, also light mode as detail."*
- **KB moved onto a shared shell** — `kb.css` + `kb.js` extracted, hub rebuilt on it, and
  `transcripts.html` added as the first deep-dive page (7 sections, 3 diagrams). Page set now
  declared up front in the hub with honest "not written yet" placeholders. The six-phase build
  workflow is recorded in the `visual-explainer` skill.
  *Reported by user: "change the whole KB to match the dataAnalyticOwnego UI UX and detail in each page."*
- **KB runs standalone** — `public/kb/serve.mjs` (`npm run kb`, or the double-click
  `Open Knowledge Base.command`) serves the knowledge base on :4400 independently of the dashboard,
  so it stays readable while :3000 is down. Uses `KB_PORT`, never `PORT` — see the 🐛 in §7b.
  *Reported by user: "I want a way to open that KB on localhost — as an independent app."*
- **Knowledge base created** — `public/kb/` hub, this record, and the `minami-kb` skill that keeps it
  in sync. Format borrowed from `~/dataAnalyticsOwnego`'s `QUERIES.md` + `toolkit/hub`.
- **`/architecture` module map shipped** — React Flow, edges extracted from source.
- **Architecture explainer shipped** — `public/kb/architecture.html`, ten sections, five interactive
  diagrams, zero dependencies.
- **`bin/serve.sh` fixed** — brace `${PORT}` so a non-UTF-8 locale can't abort the swap silently.
- **Account alert shipped** — triggers on `~/.claude.json` ground truth, not the token-slayer banner.
  *Reported by user: "alert me whenever I'm back on the wrong account."*
- **Live sessions moved to Opus 5** with effort left at the SDK default (was Opus 4.8 `--effort high`).

### 2026-07-28
- Two stability-audit passes (`6505ed2`, `7832775`) — incremental parser, cache thrash fix, atomic
  cache writes, orphaned-prompt handling, `stop()` race, process-level rejection handlers.
- Reconnect fix (`44b26fb`) — treat a bare `EventSource` reopen as an explicit re-attach.
- Hints + browser tool (`ded5cdb`) — cold-start vs mid-turn status, TodoWrite checklist, Playwright
  MCP browser with a live screenshot panel.

### 2026-07-27
- Bento reworked to Project › Goal › Task; 29 MB transcript parse 9.3 s → 39 ms; cold launch → 8 ms.
- Cross-machine metrics shipped — self-hosted collector + Tailscale Funnel; deploy moved to Vercel.

