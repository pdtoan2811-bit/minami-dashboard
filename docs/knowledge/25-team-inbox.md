# §25 — The team inbox

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

What a teammate's Claude asked you through **team-ask** (`~/dev/team-ask`), read and answered in the
dashboard, with an "Explain with AI" chat beside it. Files: `lib/team-inbox.ts`,
`app/api/team/{inbox,answer,reply,file,explain}`, `components/TeamInbox.tsx`; wired in `app/page.tsx`
(desktop: a 👥 badge beside the bell, only while something waits; phone: the inbox's first row).

## Why the dashboard talks to Slack now

`lib/team-forward.ts` says "the dashboard has no Slack of its own". That was about **asking**: the
session already holds team-ask as an MCP server, so asking through it costs nothing. **Answering** has
no such path — team-ask has no tool that answers a card in your own DM — and the reason to read here
at all is the AI chat beside the card, which Slack can't give you. So the inbox is a thin client of
team-ask's own protocol and never a second implementation of it.

## The protocol it rides on (team-ask's, unchanged)

- **Read.** `conversations.open` (bot token, users = you) → `conversations.history` with
  `include_all_metadata`. Each card carries metadata `cc_team_ask_question` whose `ctx` is a JSON
  `ContextSpec` — topic, headline, asker, repo, doing, whyNow, blocking, settled, review, questions
  with options and recommendation. The 📖 modal is rebuilt from the same object, so nothing is scraped
  from rendered blocks except **open vs closed**: a card is open while its blocks still contain the
  `answer_submit` action; closed with `:hourglass:` in the header = expired, otherwise answered.
- **Files attached to a card** are posted into its thread as text (a `:page_facing_up: *name* · N dòng`
  section, then `rich_text_preformatted` chunks), so the bot's `im:history` reads them in full. Only
  open cards' threads are fetched, cached per `latest_reply`.
- **Answer.** A `cc_team_ask_answer` relay in the card's thread: `{ts, answers_json, general_text, by,
  at}`, one `{picked, text?} | null` per question. It's the message team-ask writes when a click lands
  on a machine that doesn't own the topic; the owning machine reconciles it within ~20s. The dashboard
  is just one more "other machine". Until the card closes it shows **Sent**.

## What needs permissions the bot doesn't have

Plain DMs between two humans and their file attachments can't be read by the bot (no user
conversation access, no `files:read`). Both use an optional **user token** —
`MINAMI_SLACK_USER_TOKEN` or `SLACK_USER_TOKEN`, from the environment or team-ask's `.env` — with
`im:history`, `chat:write` and `files:read`. Without it the inbox says exactly what's missing
(`gates`) rather than showing an empty list that reads as "nobody wrote". `/api/team/file` proxies only
file ids that appeared in a listed DM; it is not a general Slack fetcher. Tokens are never logged or
returned.

## Explain with AI

`POST /api/team/explain` starts the chat **server-side** with `sendMessage` (key
`team-explain-<ts>-<t>`), because a pane has no way to be born with a message already in it. It waits
for the SDK's `init` (≤15s) and returns the session id; the page parks it in the `?open=` ref, which
already waits for a new session to reach the list, and the pane then attaches through the
`live:<id>` alias. The folder is the local checkout whose basename matches the card's `repo` (newest
session first, worktrees skipped because they get recycled), then `~/<repo>`, `~/dev/<repo>`, else
home. The seed prompt carries the whole card and attached files and tells the chat **not** to call
ask_team or post to Slack — you send the answer from the card.

## Deliberately absent

- **No push, no unread state.** Slack already notified you; a second ping for the same question is
  noise (Thomas, 2026-10-08).
- **Polling at 30s, server cache 20s** — team-ask itself reconciles every ~20s, so faster buys nothing.

Verified 2026-10-08 against the live workspace: Đức's open review card parsed with its context, four
settled points, five review steps and the attached 114-line markdown; Explain started a chat in
`~/ecvision` that read the code and PRs before answering. The relay path was **not** exercised against
a real card (it would have closed Đức's question).
