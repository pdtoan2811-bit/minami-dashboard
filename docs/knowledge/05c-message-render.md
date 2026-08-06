# Message rendering

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 5c. Message rendering — `components/Markdown.tsx`, `components/ThoughtBlock.tsx`

One dependency-light GFM-ish parser renders **both** the answer and the reasoning. `Markdown` takes a
`tone` (`"chat" | "thought"`) that selects a palette — strong/em/code/heading/rule/marker colours,
line-height, paragraph gap — and nothing else. That is the whole point: a separate thought renderer
would drift the moment a block type is added to one and not the other, and reasoning that loses its
lists and bold lead-ins is exactly the reasoning that becomes unreadable.

`caret` parks a pulsing cursor at the **end of the last block** while text is still streaming.
It's computed from the last non-empty line index up front, not appended as a trailing node, because a
cursor on its own line below the text reads as a stray artifact rather than "still writing".

### Blocks are grouped, and lists are a tree

The parser walks lines and **consumes a whole block at a time** — a paragraph swallows following lines
until a blank one or another block starts, consecutive `>` lines make one quote, and a run of list
lines is parsed into nested `LList`/`LItem` trees by `takeList()`. Three rules carry most of the
readability:

- **A single newline is a line break, not a space.** Strict markdown folds it into the paragraph. This
  is a chat panel: people press Enter meaning "new line", and their three short points must not render
  as one run-on sentence. `inlineLines()` joins with `<br/>`; every client this gets compared to
  (Claude Code included) behaves the same way.
- **Indentation shapes the list.** `LIST_LINE` captures the leading whitespace and `takeList` keeps a
  stack of open levels, so depth survives. Tabs count as two columns — any consistent rule works, but
  *not having one* is what breaks mixed indentation.
- **`pl-5` with the default `list-outside`** is what produces a true hanging indent: the marker sits in
  the padding and wrapped lines land under the item's first character, not under the bullet.

Also: `<ol start>` honours the first number (`3.` starts at three), a non-marker line indented past the
open list continues the item above it, and a blank line only ends a list when the next non-blank line
isn't another item — so an airy "loose" list stays one list.

> 🐛 **Everything structural about a typed message was thrown away.** *Reported by user: "I tried to
> convey a list and bullet points — however the xuống dòng, lùi đầu dòng is not really intuitive."*
> Five defects, all in the block parser, all confirmed against a probe before being touched:
> 1. **Nesting was flattened.** `^\s*[-*•]\s+` matched the indent and then discarded it, so a
>    three-level plan rendered as one flat column — the structure the writer used to carry their
>    meaning was the exact thing dropped.
> 2. **Every line became its own `<p>`.** With `space-y-2/3` between them, two lines of a single
>    thought got a full paragraph of air and read as unrelated statements.
> 3. **Continuation lines escaped the list.** An indented line under a bullet hit `flushList()` and
>    reappeared as a paragraph *after* the whole list, losing its hanging indent.
> 4. **Ordered lists always restarted at 1**, so `3.` rendered as `1.`.
> 5. **Consecutive `>` lines became separate blockquotes** — one quotation drawn as two stacked bars.
>
> This hit the **user's own bubble hardest**, which is why it was reported as a composer problem: both
> roles share this renderer (that's the point of the `tone` split), and `claude-sessions.ts` preserves
> newlines when it rebuilds a turn from disk — so the text was always intact and only the rendering
> lost it. Verified after the fix on a real user bubble: 44 `<br/>` and 2 lists where there had been 44
> paragraphs.

### Reasoning passes and the `---` seam

A turn's reasoning arrives as several *passes*: one before the first tool call, one after each
result. Streamed end-to-end they glue into a single contradictory paragraph — "I'll check X" running
straight into "so X was wrong" — with no way to see where a tool result changed Claude's mind.

`manager.ts` therefore marks the boundary the same way it already marks a new text block: on a second
`content_block_start` of type `thinking`, it broadcasts `\n---\n` into the thinking stream.
`ThoughtBlock` splits on that seam and draws a numbered hairline between passes.

### Gotchas
- The seam is gated on **`sawThinking`**, which the *deltas* set — not the block start. Some setups
  open thinking blocks with an empty body (see the `thinking: {display: "summarized"}` option in §3),
  and an empty pass must not earn a divider. A trailing seam with nothing after it is dropped
  client-side by the `.filter(Boolean)` on trimmed passes.
- `sawThinking` resets per **turn** (alongside `sawText` in `sendMessage`), not per message —
  `partialThinking` resets per message. Different lifetimes on purpose: the client accumulates
  thinking across every assistant message in the turn, while the snapshot only replays the current
  message.
- A literal `---` inside the reasoning itself splits a pass. Harmless — it would have rendered as a
  rule anyway — and not worth a more exotic sentinel that leaks into view if the parse ever changes.
- Collapsed, the disclosure shows pass and word counts. Without them a 40-word aside and a 900-word
  deliberation present identically, and the control gives you no reason to open either.

> 🐛 **Reasoning was one unreadable wall.** The thought block rendered the raw string in a single
> `div` with `italic`: HTML collapsed every `\n\n`, so paragraph structure vanished entirely, lists
> came out as run-on sentences, and the whole thing was set in italic — emphasis on everything is
> emphasis on nothing — at 13px muted grey. Passes from different points in the turn were glued with
> no separator at all. *Reported by user: "thought process print also need proper typography and
> divider of some sort to have better readability".*

---
