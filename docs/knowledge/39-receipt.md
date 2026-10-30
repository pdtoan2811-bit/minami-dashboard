# §39 · The chat pane's work receipt and agent pill

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

Thomas, 2026-10-30: "Area to read can be expanded, like, we wraping them like card in card … agent indicator use
case can be apply SHE method to not take too much area when I am not reading them in detail". From the pitch bench
(`~/ecvision/pitches/chat-panel`, mood board + four versions), he picked **V1 "Receipt under the answer"**: the answer
reads first, the work is one folded line under it, and the subagent fleet is a pill in the header.

## The receipt (`WorkReceipt`, `app/page.tsx`)

- **One per reply, not per row.** A reply streams as several `RenderTurn` rows (paragraph, tool run, paragraph).
  ChatColumn walks `source`, gathers every tool call between two user rows, and hands the list to the run's **last
  shown row** (`receipts: Map<RenderTurn, AgentToolCall[]>`). A fold per row put five "3 steps" lines down one answer.
- **Line:** `21 steps · 3 files · 1 agent`, one dot per tool category (`TOOL_TINT`, sorted by count), and on the right
  `N running` (live reply only) or `N failed`. Files are `writtenBy` paths, deduped; agents are the `task` category.
- **Open:** the per-call rows, unchanged (`ToolCallRow`, extracted from TurnRow). They mount only while open: a long
  run is hundreds of `JSON.stringify`s of tool input, now paid only for the reply you open.
- **"Show tool logs" (Settings)** used to decide whether calls rendered at all. Now it only sets whether receipts
  start open. Tool-only rows never render (their calls are in the receipt), except that a run with no shown row keeps
  its last row so the receipt has somewhere to sit.
- **Memo:** TurnRow is `memo`'d, so the receipt array's identity must be stable for finished replies. A
  `WeakMap<RenderTurn, {sig, tools}>` keyed on the anchor row keeps the old array until the signature (each call's id +
  done/ok) changes.
- File chips (`FileChips`) still render on their own rows, outside the receipt: what changed is the outcome of a turn,
  not tool noise (the reasoning in TurnRow's comment stands).

> 🐛 **"56 running" on a finished reply.** First cut counted `!done` as running. Calls read back from disk never carry
> `done` (`claude-sessions.ts` only sets `ok` when the result lands), so every disk reply said all its steps were
> running. Finished is now `done || typeof ok === "boolean"`, and "running" is only counted on the live row, since a
> killed turn's orphaned call is unanswered, not running. (The per-call row's own "running…" label has the same blind
> spot and predates this.)

## The agent pill (`AgentPill`, `app/page.tsx`)

Shrink · Hide · Embody, applied to the fleet:
- **Shrink:** one capsule in the pane header, `2 agents · 1:04`, breathing dot and a glow while any agent flies; a
  publish with no agent row says `publishing` (§33 trays).
- **Hide:** renders nothing when no agent is running and none finished in the last 3 minutes (the old idle bay's grace
  window; while the pane is busy, every finished agent of the turn counts).
- **Embody:** tap → the full `AgentBoard` as a popover, the same rows as before.

It replaces both in-flow copies of AgentBoard: the one inside the live `ActivityLine` and the idle bay above the
transcript for agents that outlive the turn. A reply with four agents used to push the answer half a pane down while
you read it.

Header layout: a `flex-1` spacer goes before the pill instead of `ml-auto` on the pill, because three header buttons
carry a conditional `ml-auto` of their own and two auto margins split the free space.
