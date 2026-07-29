# Minami Bento — Knowledge Record

The authoritative reasoning record for this codebase. `README.md` says how to run it; this says
**why it is shaped the way it is**, what breaks if you change it, and what already broke once.

Kept in sync by the `minami-kb` skill: *any turn that changes a subsystem updates its section in the
same turn.* A doc that lags is worse than no doc, because the next session trusts it.

- **Visual explainer:** [`public/kb/architecture.html`](../public/kb/architecture.html) — the same
  material with diagrams. Read that first if you're new.
- **Module map:** `/architecture` in the running app — real import/fetch edges.
- **Front door:** [`public/kb/index.html`](../public/kb/index.html).

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
| Transcript parser | `lib/claude-sessions.ts` | **shipped** | incremental + 3 bounded caches |
| Client SSE | `lib/use-agent.ts` | **shipped** | reconnect-aware |
| Metrics collector | `server/metrics-server.js` | **shipped** | systemd on Hetzner |
| Account bridge | `app/api/accounts` | **shipped** | reads ground-truth identity |
| Module map | `app/architecture` | **shipped** | graph data hand-maintained — see §7 |
| KB standalone server | `public/kb/serve.mjs` | **shipped** | `npm run kb` → :4400, zero deps |
| Runbook | — | **not written** | the one real gap |

---

## 1. Transcript parser — `lib/claude-sessions.ts`

**Grain:** one `SessionMeta` per `~/.claude/projects/<enc-cwd>/<id>.jsonl` file.
**Consumers:** `/api/bento/sessions` (grid), `/api/bento/session/[id]` (one transcript).

### Mechanics
Two passes. First a **stat-only** sweep over every project dir, sorted by mtime and capped to
`CANDIDATE_WINDOW = 150`. Only then does `summarize()` touch file contents. Filtering happens
*before* the expensive step, not inside it.

`summarize()` branches three ways on the cache key `(mtime, size, sha1-of-first-4KB)`:

| Condition | Action |
|---|---|
| all three match | return cached meta, **zero bytes read** |
| mtime/size changed, head hash same | read **only appended bytes**, fold into `ParseAccum` |
| head hash differs, or size shrank | discard accumulator, **full re-parse** |

> 🐛 **The bug this cost us.** The original version re-read and re-parsed the *entire* file whenever
> mtime changed. An active session appends on nearly every turn, so its mtime changes on nearly every
> 5-second poll — meaning a 29 MB transcript was fully re-parsed every few seconds on Node's single
> event loop. Every request, every open pane, and every SSE broadcast froze for the duration, for as
> long as that session stayed live.

> 🐛 **The second bug, hiding inside the fix.** With a correct incremental parser and a 500-entry
> cache, 375 transcripts still froze the app — summarizing *every* file each sweep pushed past the
> cache bound mid-sweep, so the sweep evicted and force-reparsed large files **it had just cached**.
> Cache thrash, indistinguishable from the original symptom. `CANDIDATE_WINDOW` is what actually
> fixed it.

### Gotchas
- **The head fingerprint is not optional.** A truncate-and-rewrite to a coincidentally equal-or-larger
  size is indistinguishable from an append under `(mtime, size)` alone — the parser would fold
  unrelated bytes into the accumulator and produce a permanently wrong total, silently.
- **Byte reads can split a UTF-8 character.** `Buffer#toString` replaces the fragment with `U+FFFD`,
  corrupting a line that was valid on disk. `splitTrailingIncompleteUtf8()` holds the tail fragment
  back for the next read.
- `readTail()` widens up to `TAIL_HARD_CAP` if a single JSONL line exceeds the window — a big
  embedded screenshot will do this.

---

## 2. The caches

Three caches, three bounds, each chosen for a different reason.

| Cache | Bound | Key | Why that bound |
|---|---|---|---|
| meta (`~/.minami-bento/meta-cache.json`) | 500 | mtime · size · head sha | disk-mirrored; cold launch went **9.3 s → 8 ms** |
| turns | 60 | file mtime | only a few panes are ever open |
| id → path index | 2000 | session id | cheap per entry, can afford to be large |
| *candidate window* | *150* | *mtime rank* | *not a cache — the pre-filter from §1* |

> 🐛 **Curated labels vanished.** A torn write to the enrichment cache left JSON that failed to
> parse, which returned `{}` — and the next `enrich()` wrote that empty object back, permanently
> erasing every hand-curated goal/task label. Both disk caches now write to a temp file and
> `rename` into place, and `enrich()` re-reads immediately before merging.

### Gotchas
- Caches live on `globalThis` so a Next dev hot-reload doesn't orphan them.
- Unbounded `Map`s keyed by session id are a real leak here, not a theoretical one — one entry per
  session ever seen, across weeks.

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

### Gotchas
- **Removing a session must remove both aliases**, identity-checked (`store.get(s.key) === s`),
  or cleanup for a dead session can delete a newer one that reclaimed the pane key.
- **A parked permission promise that nobody resolves pins the session `busy` forever** — no `result`
  ever arrives to trigger cleanup, so the session and its subprocess leak permanently. Three paths
  auto-deny: the idle reaper, the consumer loop's `finally`, and `closeSession()`.

> 🐛 **Stop denied the wrong turn.** `stop()` used to deny whatever was in `pending` *after* awaiting
> `interrupt()`. A fast follow-up message could raise its own prompt during that await, and get
> denied with a stale "Stopped by user". Now it snapshots pending entries before awaiting.

> 🐛 **One stale promise killed the whole server.** `setPermissionMode()` is intentionally not
> awaited from route handlers. With no handler, Node's default on an unhandled rejection is to exit
> the process — taking every open pane with it. `instrumentation.ts` installs process-level handlers
> as the backstop; `metrics-server.js` got the same after `JSON.parse("null")` (which does not throw)
> made the next line throw and killed the collector.

---

## 4. Activity labels — `lib/agent/labels.ts`

Computed **server-side on purpose**: it survives a browser refresh by riding the reconnect snapshot,
and it makes it impossible for the inline transcript indicator and the composer status line to
disagree, because there is only one source.

Phases: `idle · spawning · thinking · responding · tool · awaiting · retrying · compacting`.

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

### Gotchas
- **After a resync you hold two versions of the turn.** Prefer local blindly → lose what arrived
  during the outage. Prefer server blindly → roll back text the user already watched appear. The
  tiebreak is timing (`lastDeltaAtRef` vs the resync start), not a guess about which is fresher.
- `sentOnce` only flips true on a `snapshot` event — *proof* a live session exists — never
  optimistically on send. Until then every send carries `resume: <sessionId>`, so a lost connection
  can't silently start a fresh, context-less session.

---

## 6. Account identity — `app/api/accounts`

**Never trust `token-slayer status`'s `active` field.** It echoes a label written on the last switch
*attempt*; it is not evidence the switch took.

> 🐛 **Silently billing the wrong account.** On 2026-07-29, `state.json` claimed
> `oedevai2@gmail.com` while the real OS-keychain credential was `pdtoan2811@gmail.com`. Every
> session that day ran on the wrong account with the CLI cheerfully reporting otherwise.

Ground truth is `~/.claude.json`'s `oauthAccount.emailAddress`, written by Claude Code from the
credential it actually authenticated with. `/api/accounts` layers a `live` block carrying that, plus
`offPreferred` and `claimsMismatch`. `AccountStatus` triggers on it and **re-verifies after
switching** rather than believing the CLI's reported success.

### Caveats
- `oauthAccount.displayName` goes stale across switches (read "OE Dev" while every UUID said
  `pdtoan2811`). Use the UUID/email fields; the display name is cosmetic.
- token-slayer's stored slot for a pooled account can be a **degraded capture** (`oauth_account`,
  `plan`, `refresh_token_expires_at` all null) *even while that account is live* — it then can't
  proactively refresh, so the silent-expiry outage recurs. Not fixable from this repo.

---

## 7. Module map — `lib/module-graph.ts`

The `/architecture` graph is **hand-maintained data, extracted from source**. Static edges come from
`from "..."` specifiers, runtime edges from `fetch()`/`EventSource()` string literals naming an
`/api/` path. The extraction script is in the file header — re-run it after a refactor.

> ⚠️ **This is the one thing here that can silently go stale.** Everything else describes behaviour
> that fails loudly when wrong; a missing edge just quietly isn't drawn. If you add a module, add it
> to `NODES`/`EDGES` in the same turn.

---

## 7b. The knowledge base itself

Four parts: the hub (`public/kb/index.html`), the visual explainer
(`public/kb/architecture.html`), this record, and the module map data. Ported from
`~/dataAnalyticsOwnego` (`toolkit/hub` + `queries/QUERIES.md` + the `query-docs` skill).

The pages share `kb.css` and `kb.js` rather than each carrying its own copy of the chrome. The
"one file, zero dependencies" rule that governs a *standalone artifact* is the wrong call here —
these pages ship together in one directory, and seven copies of 250 lines of CSS drift. Still zero
dependencies: no build step, no framework, no web fonts. Same call `~/dataAnalyticsOwnego` makes
with `toolkit/brand/tokens.css`.

**Page set** (`PAGES[]` in `index.html` is the only place to edit):

| Page | State |
|---|---|
| `architecture.html` — the whole system | shipped |
| `transcripts.html` — pipeline 1: disk → parser → tile | shipped |
| Live sessions — pipeline 2 | not written |
| Cross-machine metrics — pipeline 3 | not written |
| Operations — deploy · identity · runbook | not written |

**Two ways to read it**, and the difference matters:

| | URL | Needs the app? |
|---|---|---|
| Served by Next | `localhost:3000/kb` | yes |
| Standalone | `localhost:4400` (`npm run kb`, or double-click `Open Knowledge Base.command`) | no |

The standalone server exists because `bin/serve.sh` tears :3000 down on every deploy and refuses to
restart while a turn is in flight — so the docs would be unreachable exactly when something is
broken, which is when you most want them. Zero dependencies, resolves its own root from
`import.meta.url`, walks the port up on `EADDRINUSE`.

The hub calls `/api/state` to learn which mode it's in. Only the standalone server answers; from
Next it 404s, and that failure *is* the signal that relative links already resolve. When standalone,
cards marked `needsApp` get rewritten to the app's real origin, or greyed out with "needs the app
running" if :3000 isn't listening.

> 🐛 **The KB server quietly stole the dashboard's port.** It read `process.env.PORT`, which is
> already spoken for here — `bin/serve.sh` sets it, and it's often exported in the shell. It bound
> `127.0.0.1:3000` *alongside* the dashboard's IPv6 wildcard (macOS permits that pairing rather than
> raising `EADDRINUSE`), so requests to `localhost:3000` split between two servers at random. Now
> reads **`KB_PORT`** only, and refuses to start if that equals the app's port.

---

## 8. Deployment

`bin/serve.sh` builds then swaps a **production** server on `:3000`, killing only the process bound
to that port. Production mode is deliberate: `next dev`'s Fast Refresh hot-patches the running page,
so using the dashboard to edit the dashboard's own code would change React's hook signatures
mid-session and crash the very tab driving the edit.

**The home page is local-only.** It reads `~/.claude/projects` and drives the local `claude` login,
so on Vercel it renders and finds nothing. Only `/dashboard` is remote-safe.

### Gotchas
- `INGEST_TOKEN` genuinely gates metrics writes. `READ_KEY` ships as `NEXT_PUBLIC_*`, so it is
  compiled into the browser bundle — obscurity, not auth. Real privacy needs the deploy gated.
- **`npm install` prunes devDependencies when `NODE_ENV=production` is set in the shell** (it is, in
  this environment) — which silently removes `typescript` and `tailwindcss` and breaks the build.
  Use `npm install --include=dev`.

> 🐛 **serve.sh built successfully and swapped nothing.** Line 20 read `":$PORT…"`. Under a shell
> without a valid UTF-8 locale (`LC_CTYPE=UTF-8`, which macOS doesn't recognise) bash swallowed the
> multibyte `…` into the variable name, so `set -u` aborted the script — *after* the build, *before*
> the swap. The old server kept serving and the failure looked like a successful deploy. Fixed by
> bracing: `${PORT}`.

---

## The pattern behind the incidents

Six of the eight bugs above are the same mistake in different clothes: **trusting a signal that looks
authoritative but is only a claim.** An mtime. A CLI status label. A reported switch success. A
connection that reopened. A build that exited 0.

The recurring fix is to find the thing that cannot lie — a content hash, the credential itself, a
timestamp comparison, an actual HTTP probe — and check that instead.

---

## Changelog

### 2026-07-29
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
  *Reported by user: "alert me whenever I'm back on pdtoan2811."*
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
