# §25 — The team inbox

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

What a teammate's Claude asked you through **team-ask** (`~/dev/team-ask`), read and answered in the
dashboard, with an "Explain with AI" chat beside it. Files: `lib/team-inbox.ts`,
`lib/team-chat.ts`, `app/api/team/{inbox,answer,reply,file,explain,minami}`, `app/team/minami`, `components/TeamInbox.tsx`; wired in `app/page.tsx`
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

## "Để Minami trả lời" — the AI explains, then answers on your word (2026-10-22)

The team-ask card carries a **link** button, `:robot_face: Để Minami trả lời`, for any recipient whose
`team.json` entry has a `dashboard` URL (team-ask branch `feat/minami-answer-button`; Thomas's entry is
the tailnet URL, so it opens only on his own devices). The asker's machine never calls the dashboard; it
only draws the link. The first render happens before Slack returns a `ts`, so the link names the card
by `topic` + `asker`, and `findCardByTopic` picks the newest match from a fresh inbox read.

- `/team/minami?topic=&asker=` is a page, and the page POSTs `/api/team/minami`. A GET must never be what
  answers a teammate: link previews and prefetches would.
- **One chat per card**, recorded in `~/.minami/team-minami.json` (`lib/team-chat.ts`), plus an
  in-flight promise for two clicks that land together. A second click, the phone and then the Mac, or a
  reload all land on the chat that already exists. On disk because a deploy can restart the server
  between the click and the second look.
- Only an **open** card gets a new chat. `sent` (you answered from the dashboard), `answered` and
  `expired` are refused with the reason. A second answer would contradict the first.
- The chat (key `team-minami-<ts>`, in the repo's checkout like Explain) **explains first and waits**.
  It sends through `/api/team/answer` with `minami: true, approved: true` only after you tell it to
  ("trả lời đi", "answer him", "ok send B"), using your picks where you gave them. The relay reads
  `:robot_face: Minami answered for @you on their go-ahead`; the note to the asker starts
  `🤖 Minami trả lời thay <you>:`.
- The body goes by heredoc (`--data-binary @-`): a single-quoted `-d '…'` broke on the first apostrophe
  in the note.

### The Slack talk thread (2026-10-22)

The first version answered on the click and explained afterwards ("send it then explain to me"). Used
once, Thomas wanted the reverse: understand it first, ask from Slack, then order the answer. So the
click now starts a conversation, carried on in Slack:

- `minamiAnswers` posts a head message as the team-ask bot into its DM with you ("Minami đang đọc câu
  hỏi của …") and records its ts as `thread` in `team-minami.json`. **Never the card's own thread**:
  team-ask takes any reply there as the answer and closes the card. A thread under a non-card message is
  ignored by team-ask on every machine (`pending.find` misses, nothing to reconcile).
- The bridge (`startMinamiBridge` → `tick` every 5 s, started at boot from `instrumentation.ts` and on each
  new talk) does three things per open thread. **Up:** a turn whose `ended.at` is newer than `posted` gets
  its full final text read from the transcript (`ended.text` is cut at 400 chars) and posted in ≤3,800-char
  chunks, markdown turned into Slack mrkdwn. **Down:** your replies newer than `seen`, only while the chat
  is idle, are joined into one `[Slack] …` message, sent with `resume` (so a reaped or restarted session
  comes back), and marked 👀. **Close:** once a minute it checks the card; answered or expired posts one
  line and sets `done`.
- It polls instead of subscribing, for the reason in `lib/agents/runner.ts`: a subscriber counts as a
  connected client and switches off the idle reaper and the unanswered-prompt backstop.
- Turns you take in the dashboard pane are mirrored to the thread too: the bridge keys on the session,
  not on where the message came from. If the conversation is live under another pane's key, the manager
  refuses the resume and the thread says so once.
- `/team/minami` no longer jumps into the dashboard; it says the talk is in Slack, with "Back to Slack"
  and "Open the chat here".
- Old entries without `thread` (chats from the auto-answer version) are ignored by the bridge.

Checked: the build, and the three Slack calls against the real DM (post, thread reply, reading replies
with the bot's own filtered out, 👀 reaction; test messages deleted). Not yet run end to end: no card was
open. The next card from Đức is the first real run.

## The card's layout (audit 2026-10-08)

The card opens on what's wanted from you: headline, why it's your call, the review ask, then the
questions. Files follow, then **Background** (doing, blocking, already settled) folded. It used to
open on "What they're doing" and the settled list, which put the question two screens down on a
folded phone. Send is sticky at the bottom of the scroller, names the asker ("Send to Đức"), and
stays off until every question has a pick or words — an unanswered one used to go out as `null`.
After a send the inbox re-reads at 10s and 25s instead of waiting for the 30s poll.

**Explain with AI** remembers its chat per card in `localStorage` (`minami.team-explain.<ts>`):
the button becomes "Continue the AI chat", with "or start a new one" under it. The list shows a
Review/Decision chip, "N need you", and puts open cards before sent ones. On desktop the 👥 button is
always there once team-ask is set up, quiet when nothing waits.

## Deliberately absent

- **No push, no unread state.** Slack already notified you; a second ping for the same question is
  noise (Thomas, 2026-10-08).
- **Polling at 30s, server cache 20s** — team-ask itself reconciles every ~20s, so faster buys nothing.

Verified 2026-10-08 against the live workspace: Đức's open review card parsed with its context, four
settled points, five review steps and the attached 114-line markdown; Explain started a chat in
`~/ecvision` that read the code and PRs before answering. The relay path was **not** exercised against
a real card (it would have closed Đức's question).
