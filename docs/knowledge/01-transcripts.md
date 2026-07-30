# Transcripts — parsing sessions off disk

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

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

### Turns: windows, not a tail

`getSession()` returns a **page**, not a truncated tail: `{ meta, turns, start, hasMore }`, where
`start` is the byte offset the window begins at and `hasMore` is simply `start > 0`. Every `Turn`
carries `off`, the byte offset of the JSONL line that produced it — that is what makes a window
addressable at all.

| Request | Reads | Cached |
|---|---|---|
| tail (no param) | back from EOF until ≥60 turns or ≥512 KB | by `(mtime, size)`, folded incrementally |
| `?before=<off>` | back from that offset, same rule | **forever, by byte range — never invalidated** |

The asymmetry is the whole design. A transcript is append-only, so **any window below the live tail
is immutable**: a history page is read once, ever, and the only thing that can invalidate it is a
truncate-and-rewrite, caught by the same head fingerprint `summarize()` uses. The tail is the only
volatile part, and it is folded incrementally exactly like meta — so a live pane's 2.5 s poll reads
the bytes appended since the last poll, not the window.

The in-memory window grows to `LIVE_WINDOW_TURNS = 400` then trims from the front, and `trimWindow()`
resets `start` to `turns[0].off` so a trimmed window is still a valid page and `hasMore` stays true.

> 🐛 **90% of long conversations were unreachable, with no indication.** *Reported by user: "the
> older history log transcript is not accessible for some chat or session — where it should show
> load old message".* Turns were read from a fixed 1.5 MB tail and then `slice(-120)`, so on a
> 64 MB / 1813-turn transcript **only 91 turns — 5% — could ever be displayed**; on a 12.9 MB / 863-turn
> one, 120 turns (14%). Nothing said so. The "Show N earlier messages" button computed `hiddenCount`
> from what the server had already sent, so it paged through the client-side render limit and then
> *vanished* — which reads as "you have reached the beginning of the conversation". There was no
> mechanism to ask for more: the route took an id and nothing else. The giveaway was that a pane
> showed a **title from the head of the file** (meta comes from `listSessions`' full read) above
> **turns from the tail** — 39 of 421 transcripts on disk exceed the old cap.

### Gotchas
- **The head fingerprint is not optional.** A truncate-and-rewrite to a coincidentally equal-or-larger
  size is indistinguishable from an append under `(mtime, size)` alone — the parser would fold
  unrelated bytes into the accumulator and produce a permanently wrong total, silently.
- **Byte reads can split a UTF-8 character.** `Buffer#toString` replaces the fragment with `U+FFFD`,
  corrupting a line that was valid on disk. `splitTrailingIncompleteUtf8()` holds the tail fragment
  back for the next read.
- `readTurnsBack()` widens up to `WINDOW_HARD_CAP` if a single JSONL line exceeds the window — a big
  embedded screenshot will do this.
- **Find the page boundary in the `Buffer`, not the decoded string.** Slicing mid-file almost always
  lands inside a UTF-8 sequence, so the decoded string contains `U+FFFD` and any byte offset computed
  from a *string* index is silently wrong — which is exactly the off-by-N that makes two pages
  overlap or skip the turns between them.
- **The incremental fold's chunk offset is not `cached.size`.** The held partial line's bytes were
  already counted in it, so the chunk starts that far back. Get this wrong and every turn in the fold
  is labelled with a too-large `off`, and paging from it skips everything in between.
- **The tool index must survive a fold.** `tool_use` and its `tool_result` sit on different lines and
  can land in different chunks, so it is rebuilt from the last 20 turns rather than started empty —
  otherwise a tool call parsed in the previous chunk never gets its output attached.

### Reading a transcript without the app — `bin/transcript.mjs`

The dashboard's windowing is right for a polled UI and wrong for "show me the whole conversation".
The CLI is the other half: one streaming forward pass, bounded memory, **no caps, no cache, no
server** — so it works while `:3000` is down, which is when you tend to need it.

```bash
node bin/transcript.mjs list minami-dashboard          # sessions, newest first
node bin/transcript.mjs show b33e1c2c                  # whole conversation (id prefix is enough)
node bin/transcript.mjs show b33e1c2c --tail 20 --tools
node bin/transcript.mjs show b33e1c2c --format md --out /tmp/chat.md
node bin/transcript.mjs show b33e1c2c --format json | jq -r 'select(.role=="user") | .text'
```

`--format json` emits JSONL, one turn per line — the surface for token-slayer and `jq`. Measured:
**1813 turns out of a 64 MB transcript in 0.25 s.**

> **Do not "unify" this with `lib/claude-sessions.ts`.** The similarity is superficial and the
> duplication is deliberate: collapsing them means either the dashboard full-reads on every poll, or
> the CLI inherits the window and silently stops being able to show you everything. Different jobs.

---


## 2. The caches

Three caches, three bounds, each chosen for a different reason.

| Cache | Bound | Key | Why that bound |
|---|---|---|---|
| meta (`~/.minami-bento/meta-cache.json`) | 500 | mtime · size · head sha | disk-mirrored; cold launch went **9.3 s → 8 ms** |
| turns — live tail | 60 files · 400 turns | file · mtime · size · head sha | only a few panes are ever open |
| turns — history pages | 24 pages | file · byte offset | **immutable; no mtime, no invalidation** |
| turns on disk (`turns-cache.json`) | 64 KB **per entry** | — | a turn count is the wrong budget — see below |
| id → path index | 2000 | session id | cheap per entry, can afford to be large |
| *candidate window* | *150* | *mtime rank* | *not a cache — the pre-filter from §1* |

> 🐛 **The warm-start cache was costing more than it saved.** `saveTurnsDiskCache()` ran on every
> reparse — and a live session's mtime changes on essentially every 2.5 s poll — so it did a
> `JSON.stringify` of all 60 cached sessions plus a **synchronous 7.9 MB `writeFileSync`**, on Node's
> single event loop, several times a second, exactly when the dashboard was busiest. Its own comment
> claimed this was cheap because it "only fires on an actual reparse". Now throttled to 15 s and
> budgeted **by serialised bytes, not turn count**: tool inputs/outputs dominate an entry's size, so
> 60 turns of a screenshot-heavy session serialised to ~450 KB while 60 turns of plain chat is a few.
> **7.9 MB → 251 KB**, worst case ~3.1 MB at a full 60 entries.

> 🐛 **Curated labels vanished.** A torn write to the enrichment cache left JSON that failed to
> parse, which returned `{}` — and the next `enrich()` wrote that empty object back, permanently
> erasing every hand-curated goal/task label. Both disk caches now write to a temp file and
> `rename` into place, and `enrich()` re-reads immediately before merging.

### Gotchas
- Caches live on `globalThis` so a Next dev hot-reload doesn't orphan them.
- Unbounded `Map`s keyed by session id are a real leak here, not a theoretical one — one entry per
  session ever seen, across weeks.

---
