# §33 · Upload progress: the publish tile on Bento

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

A TikTok publish (`~/tiktok-studio/scripts/uploads.mjs publish`) uploads up to ten 34–143 MB masters one
after another to Post for Me. Speeds there have been anything from 12 KB/s (10-19) to 150 KB/s (10-22),
against 2.3 MB/s elsewhere on the same line, so a publish takes from a few minutes to over an hour. On the
agent card it was one `bash` row and a clock the whole time. The uploader (`postforme.mjs uploadVideo`)
already counted bytes and worked out the rate every 10 s, but only to decide whether to abort.

Thomas asked for "upload speed, progress bar and ETA" on the card (2026-10-23). The pitch
`~/ecvision/pitches/upload-progress` drew five versions. He picked **V2, the batch tray**:

```
bash   Publishing 1 of 5 done · ~54 min left                 118 KB/s   8m 41s
       ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
       231 of 587 MB · all done about 16:17 · 1 held
  EN1  ✓ scheduled 16:00 · 136.9 MB in 11 min
  VI1  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
       62.4 / 136.9 MB · 118 KB/s · try 1 of 3                   11 min
  VI2  143.0 MB · starts ~15:33                                  31 min
  VI4  ✋ held · joke judge: …
```

## Moved to Bento: the publish tile (same day)

He pinned the tray on the agent card: *"put this one somewhere else … for easier monitoring and more"*. The card
lives in the transcript, so it scrolls away, and it exists only in the pane that started the publish. The pitch
`~/ecvision/pitches/upload-place` went three rounds:

1. A corner dock, a sidebar LIVE block, a Bento tile. He picked the **tile**.
2. A "calm" tile: a tinted status band, a chip per video, a slow · usual · fast meter. *"Not intuitive and ugly at
   the same time — moodboard first then pitch again."* The moodboard (`upload-place-mood`) put the failure down to
   codes instead of videos, four parts at equal weight, a meter that needs a legend, and borders on everything.
3. After Flighty, Live Activities, Linear and GitHub Status: a flight card, story rings, a delivery tracker. He
   picked **C, the delivery tracker**:

```
● Publishing today's videos                                    chat →
┌──────┐  Uploading now · VI2
│cover │  Sàn HOSE nghẽn lệnh năm 2021 và ba AI đối thủ
│ ring │  10 min                      ← "11 min late" in red when it will miss its slot
└──────┘  left · posts at 16:58, 57 min to spare
[✓][▣][▣][▣][✋]                                         all by 16:53
```

The video in flight, as its cover, with the minutes left; the rest as small covers. Colour only on trouble: red for
late (its ETA at the current rate is past its slot) or stuck (under 20 KB/s: the 10-19 hang ran at 12–15, a normal
Post for Me upload is 44–150), with **Ask Minami** opening the chat that started it. When the publish ends the tile
says how it ended ("All 5 posted · VI4 held: …") for 6 hours, until the next publish starts, or until Dismiss.
The agent card keeps only the one-line headline on the bash row.

## The pieces

| Where | What |
|---|---|
| `tiktok-studio/scripts/lib/upload-progress.mjs` | The writer. `begin({label, items})` once per publish (the whole batch, queued or held with why); `item(n, patch)` on each state change; `bytes({sent, size, rateBps, try, tries})` from `uploadVideo` every 2 s. One file per process, `~/.harness/progress/<pid>.json`, tmp + rename. Deleted on exit and on SIGTERM/SIGINT/SIGHUP; a SIGKILL's file is swept by the next `begin`. On exit the last state is kept in `done/<pid>.json` with `endedAt` (an item still uploading becomes `failed`, a queued one `skipped`), pruned after 3 days. |
| `uploads.mjs publish` | Announces the batch before the first byte, with each video's `title` and `cover` (absolute path), then marks each video `uploading → done` (booked slot, `tookMs`), `failed` (why), or `skipped` (no slot, paused, already scheduled). |
| `postforme.mjs uploadVideo` | A second 2 s interval beside its 10 s abort check, video uploads only, rate over the last ~20 s, so a stall shows within seconds instead of being averaged away by a fast start. A no-op outside a publish (`replace()`, hand posts). |
| `lib/agent/manager.ts` | Puts `MINAMI_SESSION_KEY=<pane key>` into every session's env, so a child process can say which chat started it. `sessionIdentity(key)` maps any key the client holds (`live:<sid>` after the first turn) back to that spawn key and the cwd. |
| `lib/upload-progress.ts` | `readUploads()` (live pids only), `uploadsFor()` (by session key; a writer with no key falls back to the same repo, worktrees folded and paths realpath'd), `trayOf()` (pure: totals, and every ETA from the current rate with uploads strictly one after another). |
| `app/api/agent/uploads` | `GET ?key&cwd` → `{ trays }`: the agent card's headline. |
| `lib/upload-progress.ts` (tile) | `readFinished()` (done/ copies, 6 h), `publishOf()` (pure: the video in flight, minutes left, minutes late against its slot, one tone), `coverOf(pid, n)`. |
| `app/api/uploads` | `GET` → `{ publishes }`: every live publish on the machine, whichever chat started it, then the finished ones, each with the `sessionId` of its chat. |
| `app/api/uploads/cover` | `GET ?pid&n` → that video's cover. The path comes only from that publish's own progress file and must be an image; the first request makes a 320 px JPEG with `sips` (~13 KB instead of ~750 KB), cached in `$TMPDIR/minami-covers`. |
| `components/PublishTile.tsx` | `PublishTiles`: first in the Bento grid in every mode but the flow canvas (a topic open and the compact split included: hiding it there was the first bug, "cant find the tile anywhere"), 2×2, one column wide in the split. Polls 4 s while live, 30 s otherwise. Dismissals in `localStorage` `bento:publishDismissed`. |
| `components/UploadTray.tsx` | `UploadPaneContext` (provided once per `ChatColumn`), `useUploadTrays()` (polls 2 s while a run is on screen, 6 s while there's none, only while an AgentBoard is mounted), `UploadTray`, `trayHeadline`. |
| `app/page.tsx` `AgentBoard` | Swaps the description of the bash row that says publish/upload/post (else the first bash row) for the headline and its tool cell for the rate. With no bash row (a foreground publish) the headline gets its own `upload` row. The tray body under it was removed when the tile shipped; `UploadTray` is no longer mounted. |

## Why it is built this way

- **A file, not the SSE stream.** A background Bash is silent to the SDK for its whole run; no event
  would ever carry a byte count. And the writer is another repo's script: a file in `~/.harness` is the
  contract both sides already use (locks live next door in `~/.harness/locks`).
- **Matched by an env var, not a pid tree.** The bash shell's ancestry does lead back to the session's
  `claude` process, but the manager doesn't hold that pid and `ps` walks per poll would be the cost of the
  feature. `MINAMI_SESSION_KEY` is inherited for free. Sessions spawned before this shipped don't have it,
  hence the same-repo fallback.
- **ETAs from the current rate only.** It is the one number that says anything about the next ten minutes;
  averaging in an earlier video's speed would hide exactly the slowdown the tray exists to show. Before the
  first byte there is no rate and the ETAs are blank, not guessed.
- **The reader never deletes.** A pid check racing a slow `exit` handler shouldn't be what destroys a file;
  the writer owns cleanup.

## Checking it

The tile: point a dev server at a scratch folder with `MINAMI_PROGRESS_DIR=/tmp/pubtest` (a file whose `pid` is a live
process, e.g. a `sleep`, plus a `done/<pid>.json` with `endedAt`). It needs no session, so `npm run dev:iterate`
style dev on :3001 is enough.

The agent card's headline:
To see the tray without publishing: write a progress file whose `pid` is a
live process and whose `cwd` is a pane's folder (or run `begin()`/`bytes()` from the writer in a loop with
that cwd), then give that pane a background bash. The dev server can't host sessions
(`node:child_process` through `lib/repo-state.ts` breaks webpack dev for every manager route), so check it
on `npm run build:check` + `next start` with `NEXT_DIST_DIR=.next-verify` on a spare port.
