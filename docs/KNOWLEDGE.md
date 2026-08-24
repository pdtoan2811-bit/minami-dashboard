# Minami Bento — Knowledge Record

The authoritative reasoning record for this codebase. `README.md` says how to run it; this says
**why it is shaped the way it is**, what breaks if you change it, and what already broke once.

**This file is an index.** The material lives in [`docs/knowledge/`](knowledge/), one file per
subsystem. That split is not tidiness — this record reached 2,500 lines / ~46k tokens, and reading it
whole cost about a quarter of a session's context to answer a question about one module. Now you read
this index (~2.4k) plus the one file you need.

Kept in sync by the `minami-kb` skill: *any turn that changes a subsystem updates that subsystem's file
in the same turn.* A doc that lags is worse than no doc, because the next session trusts it.

- **Visual explainer:** [`public/kb/architecture.html`](../public/kb/architecture.html) — the same
  material with diagrams. Read that first if you're new.
- **Module map:** `/architecture` in the running app — real import/fetch edges.
- **Front door:** [`public/kb/index.html`](../public/kb/index.html).

### Section numbers are stable

Roughly 25 code comments, two skills and `bin/deploy.sh` cite sections as `§5e`, `§8`, `§12`. Those ids
did **not** change in the split, so every one of them is still correct — the directory below is the one
hop from a `§` id to the file holding it. If you add a section, give it the next free number and never
recycle one.

---

## The directory

| Doc | Sections | ~tokens | What's in it |
|---|---|---|---|
| [`01-transcripts.md`](knowledge/01-transcripts.md) | §1 §2 | ~2,200 | Reading `~/.claude/projects/*.jsonl` — the incremental parser, windowed history paging, the three caches, and `bin/transcript.mjs`. |
| [`03-live-sessions.md`](knowledge/03-live-sessions.md) | §3 §4 §5 | ~2,800 | `manager.ts`: the session registry, the SDK `query()` loop, `canUseTool` as the permission gate, subprocess lifetime, restart safety. Activity labels and the client SSE hook. |
| [`05b-browser.md`](knowledge/05b-browser.md) | §5b | ~2,900 | The headless browser's window: state derived from tool results, the header/tabs/content layout, the console-badge post-mortem. |
| [`05c-message-render.md`](knowledge/05c-message-render.md) | §5c | ~800 | `Markdown.tsx` and `ThoughtBlock.tsx` — one parser, two tones, and the reasoning-pass seam. |
| [`05d-topics.md`](knowledge/05d-topics.md) | §5d | ~1,800 | Creating a topic: the folder picker's Recent/Browse tabs, the focus ranking behind Recent, `cwd` validation, `isTrivial`. |
| [`05e-shell.md`](knowledge/05e-shell.md) | §5e | ~10,300 | The biggest one, and past the length this split was meant to fix — split it before adding another section. Density tiers, Embody, tab-first panes, closing tabs, the hiding panel header, the bento rail, project icons, the ask card, motion/scroll cost, `--continue` parity, the composer. |
| [`05f-flow.md`](knowledge/05f-flow.md) | §5f §5f-bis | ~7,300 | The session journey — asks, semantic acts, evidence, open loops, the last-3-calls preview and the stack row — five revisions of what it got wrong, the `canUseTool` brake, and mid-turn message queueing. |
| [`05g-file-preview.md`](knowledge/05g-file-preview.md) | §5g | ~1,600 | Kind-routed file viewing, the shared side slot, the tab row. |
| [`06-accounts.md`](knowledge/06-accounts.md) | §6 | ~800 | Ground-truth account identity, and why a reported switch is not evidence. |
| [`07-knowledge-base.md`](knowledge/07-knowledge-base.md) | §7 §7b | ~1,000 | The module map's extracted edges, and how the KB itself is built and served. |
| [`08-deploy.md`](knowledge/08-deploy.md) | §8 | ~1,900 | The deploy protocol: why it detaches, why `next build` is not a compile check, why success is a changed PID *and* `BUILD_ID`. |
| [`09-concurrency.md`](knowledge/09-concurrency.md) | §9 | ~2,100 | Why two chats in one checkout collide; `bin/task.mjs` worktrees as the fix, and the dashboard auto-isolating a second chat so the fix actually gets used. |
| [`10-alerts.md`](knowledge/10-alerts.md) | §10 | ~1,600 | Disk-backed out-of-pane alerts that survive the deploy that produced them. |
| [`11-images.md`](knowledge/11-images.md) | §11 | ~1,100 | Pasted screenshots: the path is the payload, so it survives a reload. |
| [`12-rendering-cost.md`](knowledge/12-rendering-cost.md) | §12 | ~1,400 | Why the dashboard made the machine hot: idle GPU 31% → 14%, and never animate inside a `backdrop-filter`. |
| [`16-token-economics.md`](knowledge/16-token-economics.md) | §16 | ~1,100 | Where the box's tokens actually go: a cache write costs 12.5-20x a read, deploys force the re-writes, auto-compaction is inert. **Read this instead of loading the 137k-token `claude-api` skill for a price.** |
| [`13-autopilot.md`](knowledge/13-autopilot.md) | §13 | ~1,200 | Always-on merge · resolve · deploy, off by default. Was a second `§12`; renumbered. |
| [`14-agents.md`](knowledge/14-agents.md) | §14 | ~3,000 | Standing agents: identity + home folder ≠ cwd, scaffold vs adopt, the onboarding interview, the unattended task runner (and why it polls), attribution rules, HQ and `bin/agent.mjs`. |
| [`15-teams.md`](knowledge/15-teams.md) | §15 | ~2,600 | Teams: templates → standing agents, a product's three lifespans (run · record · repo block), the chain runner, and why a handoff is a file rather than a payload. |
| [`17-meeting-canvas.md`](knowledge/17-meeting-canvas.md) | §17 | ~1,900 | `/canvas`: audio → transcript → ReactFlow board. Why using a chat LLM as the transcriber costs latency, accuracy *and* money, OpenRouter's STT catalogue with prices, and the specified-but-unbuilt replacement. |
| [`18-meeting-launch.md`](knowledge/18-meeting-launch.md) | §18 | ~1,500 | Getting Minami into a call: the two launchers, the receiver on :8787, the cloudflared quick tunnel, and the shared `bin/tunnel-lib.sh`. Why this Mac's DNS opinion is not the question, and the 1800s negative-cache trap that made the launcher poison its own probe. |
| [`CHANGELOG.md`](knowledge/CHANGELOG.md) | — | ~9,400 | Dated log of every change. Append here; don't read it to do work. |

---

## The pattern behind the incidents

Six of the eight bugs recorded in `12-rendering-cost.md` and `06-accounts.md` are the same mistake in
different clothes: **trusting a signal that looks authoritative but is only a claim.** An mtime. A CLI
status label. A reported switch success. A connection that reopened. A build that exited 0.

The recurring fix is to find the thing that cannot lie — a content hash, the credential itself, a
timestamp comparison, an actual HTTP probe — and check that instead.

This is the single most reusable thing in the record, which is why it sits in the index rather than in
one subsystem's file. Every `> 🐛` post-mortem in `docs/knowledge/` is an instance of it.

---

## Data flow

Three pipelines run at once. Most confusion about this codebase comes from reading one and assuming
it explains another.

```
LIVE      browser pane → /api/agent/send → manager.ts → Agent SDK → claude CLI
                       ← /api/agent/stream (SSE) ←

READ      claude CLI writes ~/.claude/projects/*.jsonl
          → claude-sessions.ts (incremental parse + 3 caches) → /api/bento/* → grid tiles

METRICS   Stop hook on EVERY machine → metrics-server.js (Hetzner, loopback)
          → events.jsonl → Tailscale Funnel → /dashboard cards
```

The live and read pipelines meet only on disk. They never call each other.

---

## Subsystem status

| Subsystem | File | State | Notes |
|---|---|---|---|
| Live sessions | `lib/agent/manager.ts` | **shipped** | Opus 5, effort unset, 60% autocompact |
| Activity labels | `lib/agent/labels.ts` | **shipped** | server-derived, survives refresh |
| Transcript parser | `lib/claude-sessions.ts` | **shipped** | incremental meta *and* turns; windowed history paging — see §1 |
| Transcript CLI | `bin/transcript.mjs` | **shipped** | full history, no server, no caps — see §1 |
| Client SSE | `lib/use-agent.ts` | **shipped** | reconnect-aware |
| Metrics collector | `server/metrics-server.js` | **shipped** | systemd on Hetzner |
| Account bridge | `app/api/accounts` | **shipped** | ground-truth identity; preferred account set in Settings |
| Browser panel | `lib/browser-view.ts` + `components/BrowserPanel.tsx` | **shipped** | derived from tool results; observer-only — see §5b |
| Topic creation | `components/FolderPicker.tsx` + `app/api/fs/*` | **shipped** | Recent/Browse tabs; opens on the ranked list; cwd validated — see §5d |
| Topic ranking | `lib/topic-rank.ts` | **shipped** | depth × recency + did-you-come-back; floors out scratch folders, `/tmp` and `$HOME` — see §5d |
| Message rendering | `components/Markdown.tsx` + `components/ThoughtBlock.tsx` | **shipped** | one parser, two tones — see §5c |
| Shell (bento · rail · composer) | `app/page.tsx` + `components/BentoRail.tsx` | **shipped** | grid collapses to a rail — see §5e |
| Density tiers | `lib/density.ts` | **shipped** | measured roomy/snug/tight/micro; chrome folds, ⌥1–4 — see §5e |
| Side-slot tabs | `components/PanelTabs.tsx` | **shipped** | one tab row worn by the file preview AND the browser — see §5b, §5g |
| Flow view | `components/FlowCanvas.tsx` + `lib/flow-model.ts` + `lib/flow-narrate.ts` + `lib/flow-stack.ts` | **shipped** | one spine per session, one node per ask: what was wanted, what it did, what's still open, its last 3 calls and the stack they touched — see §5f |
| File preview | `components/FilePanel.tsx` + `lib/file-view.ts` + `app/api/fs/file` | **shipped** | any file type, paged; shares the side slot with the browser — see §5g |
| Module map | `app/architecture` | **shipped** | graph data hand-maintained — see §7 |
| KB standalone server | `public/kb/serve.mjs` | **shipped** | `npm run kb` → :4400, zero deps |
| Runbook | `public/kb/operations.html` | **shipped** | deploy · identity · symptom table |
| Deploy wrapper | `bin/deploy.sh` + `Redeploy Minami.command` | **shipped** | detaches from its requester; mutually exclusive — see §8 |
| Task isolation | `bin/task.mjs` | **shipped** | one task = one worktree = one branch = one agent — see §9 |
| Out-of-pane alerts | `bin/minami-event.mjs` + `lib/events.ts` | **shipped** | disk-backed, survives the deploy that produces them — see §10 |
| Images in a message | `lib/agent/images.ts` + `app/api/fs/paste` | **shipped** | paste a screenshot; path is the payload, so it survives a reload — see §11 |
| Rendering cost | `app/globals.css`, `ProjectIcon.tsx` | **shipped** | idle GPU 31% → 14%; never animate inside a backdrop-blur — see §12 |
| Standing agents | `lib/agents/*` + `app/agents/*` | **shipped** | opt-in roster; identity + home folder, not cwd. Verified end-to-end 2026-07-30 — see §14 |
| Agent task runner | `lib/agents/runner.ts` | **shipped** | unattended runs, write-back, handoffs; polls rather than subscribes — see §14.3 |
| Agent CLI | `bin/agent.mjs` | **shipped** | how HQ delegates; thin wrapper over `/api/agents` — see §14.5 |
| Teams | `lib/teams/*` + `app/teams/*` | **shipped** | templates → standing agents; one task, N sessions, one dossier — see §15 |
| Chain runner | `lib/teams/run.ts` | **shipped** | each stage is an ordinary agent task; polls the task record — see §15.4 |
| Team CLI | `bin/team.mjs` | **shipped** | what the repo's CLAUDE.md team block names — see §15.3 |
| Meeting canvas | `lib/mimo.ts` + `lib/audio.ts` + `app/api/canvas/live` | **partial** | works off a hardcoded mp3. Still no audio-capture leg, so nothing "joins" a call yet — see §17 |
| Canvas A/B harness | `lib/canvas-modes.ts` + `?mode=` + the panel scorecard | **shipped** | 3 arms, one variable each, `report` event per run. Verified end-to-end 2026-08-10: control produced nothing in 175s, real-ASR arm got first transcript in 1.4s — see §17 |
| Meeting launch | `bin/Minami Call.command` + `bin/meet-now.sh` + `bin/tunnel-lib.sh` | **shipped** | app :3011 → receiver :8787 → quick tunnel → Recall. Shared probe verified against a live tunnel 2026-08-24 (detects in ~1s; the poisoned-cache path detected never) — see §18 |

---

---

## Adding to this record

1. **Find the owning file** in the directory above and edit its section. Don't start a new section for
   something that belongs in an existing one.
2. **If it was a bug, write the post-mortem** as a `> 🐛` callout: what broke, how it presented, and
   *why*. The failure mode is the valuable part — anyone can read the diff. Say if a user reported it.
3. **If a module changed**, update `lib/module-graph.ts` — it is the one artifact that goes stale
   silently, because a missing edge just isn't drawn.
4. **Update the subsystem status table** above if a subsystem's state changed.
5. **Add a dated entry** to [`knowledge/CHANGELOG.md`](knowledge/CHANGELOG.md), newest first, absolute
   dates.
6. **New doc?** Add a row to the directory above. A file nobody can find from here does not exist.

Never claim something is shipped without verifying it — `next build` exiting 0 is not evidence the
server swapped. Record the reasoning, not the diff: the value is why the obvious alternative was
rejected.
