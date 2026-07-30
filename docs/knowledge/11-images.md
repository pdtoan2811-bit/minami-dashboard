# Images in a message

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 11. Images in a message — `lib/agent/images.ts`, `app/api/fs/paste`, `app/api/fs/image`

Paste a screenshot into the composer and Claude sees it in that turn.

### Everything follows from one decision: the payload is a PATH, not bytes

`Composer.tsx` states the invariant — *the textarea is the single source of truth for what Claude
receives* — and the attach button already honoured it by inserting a **path** ("inserts its path for
Claude to read"). Paste keeps that shape: bytes land on disk, the path goes into the text, and
`/api/agent/send` reads whatever image paths the outgoing message mentions and attaches them inline.

That one choice pays for itself four times:

- **No second source of truth.** Delete the path from the box and the attachment is gone; there is no
  separate pending-attachment state to drift out of sync with the text.
- **The attach button gets thumbnails and inlining for free** — by the time a picked file reaches the
  renderer it is indistinguishable from a pasted one.
- **No base64 crosses the wire from the browser.** The server reads the file it just wrote.
- **It survives a reload.** This is the load-bearing one — see below.

### Why an inline image block alone would have been a bug

`claude-sessions.ts` rebuilds a user turn from the on-disk JSONL by pulling out **text blocks only**
(`if (b?.type === "text")`). `Turn` has no image field. So an image block in a user message renders
live — the client still holds it — and then **vanishes on the next reload, reattach, or project
switch**, because the pane rebuilds from disk. `trimOutput` in `app/page.tsx` would strip it from
sessionStorage too, for the quota reasons recorded there.

A path is text. It survives the parser, so the thumbnail comes back. The image itself is re-derived
from the file — which is exactly why the pastes directory exists and why 24h is the right retention:
the model already got the picture inline at send time, so the file is a **rendering cache**, not the
payload. Losing it a day later costs a thumbnail in old scrollback, never the conversation.

### Mechanics
- **`~/.minami/pastes/`, not `<cwd>`.** `.playwright-mcp/` gets away with living in the project
  because the MCP server writes it and this repo's `.gitignore` covers it. The dashboard pastes into
  *every* topic's folder and cannot edit their gitignores. Chat input is not a project artifact.
- **`POST /api/fs/paste` takes no path input at all** — fixed root, server-generated filename. There
  is nothing for a caller to traverse with, unlike `/api/agent/browser/file` (client-supplied `cwd`).
- **Magic bytes, not extensions.** Both routes check the header bytes. Verified: a renamed
  `.env.local` with a `.png` extension is rejected 400.
- **Image first, then text** in the content array — the API's own vision guidance, and Claude attends
  to a question asked *after* the evidence more reliably than before it.
- **Content stays a bare string when there are no images**, so the parser, caches and on-disk history
  are untouched until an image is actually present.
- **Best-effort inlining.** A missing/oversized/fake image just isn't attached; the path stays in the
  text, degrading to exactly the old behaviour (Claude can `Read` it).
- **Only intercept a paste that carries an image.** Plain text must paste unchanged — a handler that
  swallows ordinary Cmd-V is far worse than no handler. Verified both ways.

### Gotchas
- **A bare path cannot express a space**, and the commonest image on a Mac is
  `~/Desktop/Screen Shot … .png`. The matcher therefore accepts a **quoted** path too, and the folder
  picker quotes any path containing whitespace. Without this the feature would fail silently — no
  thumbnail, no inline image, no error — on the exact file it will most often be pointed at.
- The path regex is duplicated in `lib/agent/images.ts` (what gets *sent*) and `app/page.tsx` (what
  gets *shown*). They must stay in step: a path that renders but isn't inlined, or vice versa, is a
  lie in one direction or the other.
- Caps are 5 images/message and 5MB each. The Anthropic API downsizes >1568px itself, so the cap is
  about not shoving tens of megabytes through a local request, not about token cost.

---
