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

`caret` parks a pulsing cursor at the **end of the last paragraph** while text is still streaming.
It's computed from the last non-empty line index up front, not appended as a trailing node, because a
cursor on its own line below the text reads as a stray artifact rather than "still writing".

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
