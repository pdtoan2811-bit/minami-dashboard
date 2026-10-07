# §5h. Chat titles that keep up — `lib/bento-enrich.ts` (`retitle`), `lib/retitle.ts`, `lib/chat-title.ts`

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

## 5h. What a chat is called, and when that changes

A chat has three names. Every surface shows the first that exists: **`now || task || title`**
(`titleOf` in `app/page.tsx`; `/glance` and the push notifier make the same choice).

| | Where it comes from | When it changes |
|---|---|---|
| `title` | `lib/claude-sessions.ts`: a `custom-title` rename, else the first ask that names a topic (`titleSeed`), else the latest prompt | frozen once seeded |
| `task` | Haiku via `enrich()`, from the **opening** ask, 4–7 words | once; again only when a settled session grows by 30+ messages |
| `now` | Haiku via `retitle()`, from the **last three real asks** | every 3 real asks, at the end of a turn |

`task` is deliberately anchored to the opening ask: a label that chased the latest message once
renamed a forty-turn chat "deploy the app". But a chat that genuinely moves on (this one went from
model pins to the ask card to link cards to a deploy to team-ask) kept its first name all day. On
the phone, where the title is most of what you see, that read as not knowing where you are.

> 🐛 **"I keep getting outdated titles when the conversation already changed topics" (2026-10-07).**
> Two rules combined. `needs()` never relabels an **active** session (a chat you're using is active),
> and the label is built from the opening ask. A chat you used all day kept the label from its first
> message. Claude Code's own `ai-title` rows were checked as a free fix and don't help: this session
> had 67 of them, all the same text, never revised.

**How `now` is kept current.**
- `claude-sessions.ts` counts **real asks** (`asks`, the last three; `askCount`). A real ask has
  text, doesn't open on a tag (`<task-notification>`, `<system-reminder>`, local-command echoes are
  harness injections) and passes `looksLikeATopic`, so "ok do it" doesn't count. `PARSE_VERSION` went
  to 3 so open chats were re-read once and didn't start counting at zero.
- `retitle()` runs when `askCount` is 3+ past the count the last `now` was made at, and the chat's
  last word is the assistant's (never mid-stream). One Haiku call at a time, ≤8 chats per call.
- **Triggers:** the live manager's `result` (via `retitleSoon`, 1.5 s later so the CLI has appended the
  turn) for every dashboard chat, and `/api/bento/enrich` for chats that moved while nobody had
  them open (terminal sessions).
- `enrich()` spreads the existing entry, so a later `task`/`goal` relabel never drops `now`. A chat
  that gets a `now` before it was ever labelled is stored with an empty goal, so `enrich()` still
  labels it properly.

Measured on this session: opening "Fan out mode sonnet 5.5…", `task` "Merge V1 card and team share
features", `now` "Testing rolling title across phone versions", one Haiku call.

## "Project: title" on the phone

`lib/chat-title.ts` (`projectLabel`, `chatTitle`) and `components/ChatName.tsx` render
"**Minami dashboard:** the title", with the project half dimmer. They're used on the inbox row, the
focus dock pill and sheet rows, `/glance` (header and list) and push notification titles. The inbox's
second line no longer repeats the project. **Not on the desktop board**, where a chat already sits under
its project's tile and the prefix would only repeat it. A title that already opens with the project
name isn't prefixed twice. Asked for in exactly this shape, 2026-10-07.

---
