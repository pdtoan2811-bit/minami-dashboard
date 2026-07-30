# File preview

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 5g. File preview — `components/FilePanel.tsx`, `lib/file-view.ts`, `app/api/fs/file`

Before this, the dashboard could preview exactly one thing: images. A `Read`/`Edit` target was a path
inside a collapsed JSON blob, and Flow's "files touched" listed names with nothing behind them.

**The brief was explicitly "not just code" — think of a marketer or a designer using it.** That is what
makes this a *kind-routed* viewer rather than a text box with syntax colouring: a PNG, a PDF, a CSV and
a `.tsx` are four different reading experiences, and `.ipynb` is JSON on disk but a notebook to a
human. Routing on kind is the feature; highlighting is one branch of it.

### It shares the browser's slot, it doesn't add a second one
Both panels want the same place — docked beside the chat, drag-resizable — and a pane can already be a
quarter of the window. Two independently-openable side panels would leave the transcript unreadable and
give one drag handle two meanings. So there is **one slot, one width**, and a tab strip that only
appears when both have something to show. `activeSlot` falls back rather than trusting the persisted
choice: a session that only touched files never shows a blank browser panel just because `"browser"`
was the stored default.

### created vs changed comes from the RESULT, not the tool name
`Write` both creates files and silently overwrites existing ones, so keying off the tool name labels
every overwrite "created" and lies about a file that already had contents. The CLI's own result text
distinguishes them exactly — `File created successfully at: <path>` vs `The file <path> has been
updated successfully` — so `verbOf()` reads that, falling back to the tool name only while a call is
still in flight. Same trick as parsing `Task #N` out of `TaskCreate`'s result in §5f.

Verbs never downgrade: re-reading a file after editing it doesn't turn it back into a read.

### Robustness is in the route, not the component
`/api/fs/file` is the load-bearing piece, and every limit is there for a measured reason:

- **Text is a bounded slice (256 KB/request), never a whole file.** This server is single-threaded and
  shared by every open pane, so one careless read of a minified bundle stalls everyone. Verified: a
  3.3 MB log returns 262 KB with `truncated: true` and a `nextOffset`.
- **A slice is trimmed back to the last newline**, so `nextOffset` is a clean boundary and paging never
  splits a line of code across two fetches. Verified: page 2 resumes at exactly the next line, no gap,
  no overlap.
- **Binary is detected by a NUL byte in the first 8 KB** — the same test `grep -I` and git use. It
  costs one small read and never mistakes UTF-8 prose for binary the way an entropy heuristic can.
  Verified: a copy of `/bin/ls` renamed to `.txt` is still refused, so a mislabelled file can't reach
  the client as mojibake.
- **`raw=1` is an allow-list**, not a mime guess — only types a browser *displays* (pdf, image, video,
  audio). An open-ended raw endpoint is a data-exfiltration shape. Verified: `raw=1` on a `.ts` and on
  `/etc/passwd` both 400.
- **`no-cache` on raw**, unlike `/api/fs/image`'s hard cache. A pasted screenshot is immutable; a
  source file changes under you, and a stale preview of a file Claude just rewrote is exactly wrong.

The unconfined-`path` argument is unchanged from `/api/fs/list` and `/api/fs/image`, and per CLAUDE.md
is deliberately **not** gated on `Host` or `x-forwarded-for` (forgeable; neither proves locality).

> 🐛 **The chips rendered zero times, and the panel made it worse.** Putting them outside the
> `showTools` gate wasn't enough: `allVisible` drops turns with no assistant text, and a turn that only
> writes a file usually has none. Measured on a real 63-turn session — 5 files written, **0 of those
> turns carried text**, so every one was filtered out before `TurnRow` ever saw it. The side panel still
> listed all 5, so the transcript and the panel disagreed about whether anything had happened.
>
> Fix: a turn now survives the filter if it *said* something **or** *changed* something
> (`t.tools.some(writtenBy)`). Only findable by running it — the component was correct in isolation.

### Gotchas
- **The chips are outside the `showTools` gate**, and the visibility filter knows about them (above).
  Which files changed is the *outcome* of a turn, not tool noise. They de-duplicate per path within a
  turn, because Claude routinely applies several `Edit`s to one file in one turn — but not across
  turns, since a chip marks what *that* message did.
- **The file rail is now a tab row** (`components/PanelTabs.tsx`), shared with the browser panel. The
  rail was vertical for a good reason — file names are long, and horizontal truncation leaves every
  entry reading `…/components/Bro…` — but it cost a fixed **144px of width** in a panel that is often
  ~290px wide, which is why it had to vanish below 340px and be replaced by a native `<select>`. That
  left the panel with *two* navigation models depending on its width, and the narrow one hid the list
  behind a click: you couldn't see that three files had been touched without opening it. A tab row costs
  ~24px of **height** at any width and shows every entry at once. Truncation is handled rather than
  ignored — the row scrolls, the active tab is `scrollIntoView`'d, and each tab keeps the full path as
  its `title`, which matters because two files called `page.tsx` is the normal case in this repo.
- **The panel is still an `@container`** for everything else that sizes off the panel rather than the
  window.
- **`onOpenFile` must be a `useCallback`.** `TurnRow` is memoised; a fresh closure defeats it for every
  row on every render.
- **CSV is parsed, not split on commas** — a quoted field containing a comma is the normal case in
  exported data. Rows are capped at 500 rendered; a 50k-row export would otherwise mount 50k `<tr>`s.
- A truncated slice of a big `.ipynb` is invalid JSON, so the notebook renderer says so and offers the
  source toggle instead of rendering blank.

> ⚠ **Concurrent builds collide through the dist dir.** Two agents running `npm run build:check` in the
> same checkout both write `.next-verify`, and the loser fails in *Collecting build traces* with a
> baffling `ENOENT … instrumentation.js.nft.json` — nothing to do with the code being checked. Same
> class as a `task.mjs preview` server holding `.next-task` while a merge builds into it (§5f). When
> the tree is busy, build into a private dir: `NEXT_DIST_DIR=.next-<something> npx next build`.

---
