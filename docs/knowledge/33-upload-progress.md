# §33 · Upload progress on the agent card

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

## The pieces

| Where | What |
|---|---|
| `tiktok-studio/scripts/lib/upload-progress.mjs` | The writer. `begin({label, items})` once per publish (the whole batch, queued or held with why); `item(n, patch)` on each state change; `bytes({sent, size, rateBps, try, tries})` from `uploadVideo` every 2 s. One file per process, `~/.harness/progress/<pid>.json`, tmp + rename. Deleted on exit and on SIGTERM/SIGINT/SIGHUP; a SIGKILL's file is swept by the next `begin`. |
| `uploads.mjs publish` | Announces the batch before the first byte, then marks each video `uploading → done` (booked slot, `tookMs`), `failed` (why), or `skipped` (no slot, paused, already scheduled). |
| `postforme.mjs uploadVideo` | A second 2 s interval beside its 10 s abort check, video uploads only, rate over the last ~20 s, so a stall shows within seconds instead of being averaged away by a fast start. A no-op outside a publish (`replace()`, hand posts). |
| `lib/agent/manager.ts` | Puts `MINAMI_SESSION_KEY=<pane key>` into every session's env, so a child process can say which chat started it. `sessionIdentity(key)` maps any key the client holds (`live:<sid>` after the first turn) back to that spawn key and the cwd. |
| `lib/upload-progress.ts` | `readUploads()` (live pids only), `uploadsFor()` (by session key; a writer with no key falls back to the same repo, worktrees folded and paths realpath'd), `trayOf()` (pure: totals, and every ETA from the current rate with uploads strictly one after another). |
| `app/api/agent/uploads` | `GET ?key&cwd` → `{ trays }`. |
| `components/UploadTray.tsx` | `UploadPaneContext` (provided once per `ChatColumn`), `useUploadTrays()` (polls 2 s while a run is on screen, 6 s while there's none, only while an AgentBoard is mounted), `UploadTray`, `trayHeadline`. |
| `app/page.tsx` `AgentBoard` | Hangs the tray under the bash row whose description says publish/upload/post (else the first bash row), and swaps that row's description for the headline and its tool cell for the rate. With no bash row (a foreground publish) the tray gets its own `upload` row. |

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

To see the tray without publishing: write a progress file whose `pid` is a
live process and whose `cwd` is a pane's folder (or run `begin()`/`bytes()` from the writer in a loop with
that cwd), then give that pane a background bash. The dev server can't host sessions
(`node:child_process` through `lib/repo-state.ts` breaks webpack dev for every manager route), so check it
on `npm run build:check` + `next start` with `NEXT_DIST_DIR=.next-verify` on a spare port.
