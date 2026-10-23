# §34 · Attention items: resolve, comment, auto-check

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

Thomas, 2026-10-23, pinned on the Runners tab's "11 videos won't go out on their own": *"need a resolve + comment UX like
in today to do list features or auto check if things are still not resolve … things like that across the dashboard
should need some UX like that — since things have moved but the indicators stale."*

The panel read tiktok-studio's day state on every load, so it wasn't cached. It was stale because the state was: a
joke-judge hold stays on an item until the next `make` re-reads it, so EN2/EN3 of 10-22, fixed and re-rendered that
morning, still said Held. Days that never finished (10-20, 10-21) never archived either. Nothing let him say "handled",
"dropped", or leave a note.

## The pattern

| Piece | What it does |
|---|---|
| `lib/attention.ts` | The store, `~/.minami/attention.json` (`MINAMI_ATTENTION_FILE`). `track(scope, flags, settled?)` reconciles what a panel flags NOW with what was recorded; `act({op})` is Thomas's hand: resolve (with a one-tap `how` and a note), reopen, comment, chat. |
| `app/api/attention` | `POST {op, key, …}`. `op: "ask"` starts a chat in a runner's folder through `askAbout` (lib/autopilot-ask.ts) with the flag as its subject, and records the chat on the flag. |
| `components/AttentionRow.tsx` | `AttentionRow`: Today's row for a flag — tick to resolve, tap to open, comments, "Ask Minami", Resolve: Fixed / Dropped / …. `AttentionFold`: the "Resolved · N" fold, YOU rows with Reopen, AUTO rows with their evidence. |

The rules `track` applies, every read:

- **Open** — flagged, not resolved.
- **Resolved by you** — stays resolved while the flag's `sig` (its state and reason) is unchanged. He said it's handled.
- **Changed** — resolved, but the `sig` changed: open again, with a CHANGED chip. A different problem now.
- **AUTO** — was flagged, and the source no longer flags it: resolved by `auto` with the panel's evidence
  ("booked for Fri 16:00", "posted", "its day was archived"). Today's AUTO tick, for flags. If the source flags it
  again, it reopens as CHANGED.
- Resolved entries stay in the fold for 3 days, then drop out of the file.

A panel adopts it in three lines: give each flag a stable `key` (namespaced: `video:2026-10-22 Thu:EN2`), a `sig`, and
a `meta` the fold can name it by once the source stops listing it; call `track` where it builds the list; render
`AttentionRow` / `AttentionFold`.

**Why a store beside the source, not a write into it.** The flags come from other repos' state files (tiktok-studio's
`.state.json`, launchd exit codes), each with its own single writer. "I've handled this" is the dashboard's fact, not
theirs; writing it into their state would make the dashboard a second writer. The auto-check is what keeps the two
honest: the moment the source moves, the flag ticks itself.

## Adopted

- **Runners → Up next → videos that won't go out on their own** (`lib/upnext.ts`, `app/autopilot/UpNext.tsx`):
  scope `video`, reasons Fixed / Dropped / Posting by hand, Ask Minami in the overnight runner's folder.
  The input and the **Minami ↵** button sit on every row, not behind the tap (he looked at the first version and
  asked "Minami button and input text please??"); Enter asks Minami, Comment only saves the note. A box above the list
  asks about all of them at once: `askAbout` adds every open video to the overnight runner's context
  (`waitingVideos()` in lib/autopilot-ask.ts).

## Not yet adopted (inventory, 2026-10-23)

Indicators that show a stored condition with no way to mark it handled — the next candidates:

- Runner "Failed" (`RunnersSection.tsx`, from launchd `lastExit`): stays red until a clean run.
- Day strip "N need a look" (`DayStrip.tsx` `lookOf()`): failing / not loaded / silent / missed / partial.
- Storage alarms (`StorageSection.tsx`, the Autopilot storage chip): janitor stale, below floor.
- Goals "Behind" and machine-trouble text (`PhoneAutopilot.tsx`): reflects the last run until the next.
- Account / model drift card (`components/AccountStatus.tsx`): Collapse hides the card, the chip stays.
- AutopilotTile "Needs you" (`components/AutopilotTile.tsx`).

"Needs you" on chats (Glance, Focus, Inbox, Asks) clears by answering, which is right for a live question; those
aren't candidates.
