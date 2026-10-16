# §28 — Ideas

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

`/ideas`: a stash of things Thomas reads or finds funny — news, memes, links, screenshots, forwarded
messages, half-thoughts — kept so they can feed a daily brainstorm. Built 2026-10-14.

Thomas: *"something like a hub to store news I read or find funny, that can be used to brainstorm new
ideas every day … input is much more misc, like meme, image, url with or without saying anything …
self organize day by day and by hot/cold … 50% of the time I send something on phone, 50% on laptop …
I just chat and send."* He chose (2026-10-14): **DM Minami with auto-detect** (no new channel),
**Ownego/Qikify** workspace, morning idea seeds on the **Today page only**, name **Ideas**.

Files: `app/ideas/{page,Ideas}.tsx`, `app/api/ideas/route.ts`, `app/api/ideas/media/[id]/[n]/route.ts`,
`lib/ideas.ts`; the bot side in `~/Minami`: `src/ideas.js`, `bin/ideas-add.mjs`, the DM handler in
`src/app.js`. Shared look: `app/today/ui.tsx` (split out of `Today.tsx` for this page).

## Two halves, one store

```
Slack DM ──► ~/Minami/src/ideas.js  ─┐                     (the bot: capture, read, tag)
/ideas drop box ─► bin/ideas-add.mjs ─┤──► ~/.minami/ideas/items/<date>/<id>.json  + media/
                                      │
/ideas page ◄── lib/ideas.ts (read, rank, ★ / comment / remove) ◄┘
```

- **The bot owns capture and tagging.** The dashboard's drop box doesn't tag anything itself: it saves
  the upload to `inbox/<id>/` and spawns the bot's `bin/ideas-add.mjs`, detached. An item from the page
  and one from Slack go through the same `fill()`, so they look the same. A dashboard deploy can't cut a
  read short.
- **The dashboard owns ranking and the page's edits.** Both sides write one JSON per item by atomic
  rename, so either can write while the other reads. They never share a process: the bot is its own
  launchd job (`com.thomas.minami-bot`) and survives dashboard deploys.
- **Local, not the vault.** Images would bloat the vault's git and sync to every device. Only kept ideas
  will go to the vault (step 4).

## Capture — auto-detect in the DM (`classify` → `decide`)

Cheap rules first; a model only when it's honestly ambiguous.

| Message | Result |
|---|---|
| files (image, meme, screenshot, PDF) | save |
| a bare link, or a link + a few words (no question) | save |
| a forwarded / shared message (`attachments[].is_share`) | save |
| `task:` / `note:`, a question, a request verb (find, check, tạo, giúp…), > 220 chars | answer (the normal assistant) |
| short plain text | **haiku decides**; if it saves, the thread says "reply `ask` if you meant a question" |

Overrides: `idea: …` saves, `ask: …` / `? …` answers. Under a saved item: reply `ask` → it is removed
and answered; any other reply → a comment; ❌ → removed. On only for `IDEAS_TEAMS` (Ownego) and only for
the owner; QDN stays answer-only.

A save: 👀 → download files (needs `files:read`; Slack answers a missing scope with a 200 HTML login
page, so the content type is checked) → read each link (title, og tags, a text excerpt; for sites that
block it — X, TikTok — Slack's own unfurl, fetched ~4 s later) → **Claude haiku** via the toolshed's
quarantined `claude.mjs` (vision for images) → ✅ and one line in the thread: `💡 meme · title — gist`.

> 🐛 **Haiku answered in prose.** The first link test came back "I don't have access to that link…"
> instead of JSON, because the model tried to visit the URL. Fix: a system prompt pinning the format,
> "do not try to open the link" in the prompt, and one retry quoting the failure back.

> 🐛 **Instagram can't be read by anything but a logged-in browser (2026-10-14).** His first real save was
> an Instagram post. It answered every fetch with 200 and a page titled "Instagram": browser UA,
> `facebookexternalhit`, `Twitterbot`, and even `/embed/captioned/`, which holds only Meta's app code.
> Slack didn't unfurl it either. Haiku then filed "Instagram post (no context)". **Fix:** `readLink`
> treats a page whose title is just the site's name, with no description, as a wall. An item with
> nothing readable is `blind`, and the thread asks him for a line or a screenshot. His reply goes
> through `addContext`, which downloads, re-reads and posts the new gist.
>
> 🐛 **Same day, a `.env` append with no newline.** `IDEAS_TEAMS=…` was appended to a `.env` that didn't
> end in `\n`, so it ran onto the end of `SLACK_APP_TOKEN_B`. Slack then rejected the app token as
> `invalid_auth`, which read as "revoked", and he regenerated it. A later rewrite of that line dropped
> `IDEAS_TEAMS` entirely, so his first Instagram link went to the assistant. Append to `.env` only
> after checking the last byte.

**Fixed for real the same day: a logged-in browser.** Thomas: *"the browser harness approach … let me
login instagram and more, and use it to view things"*. The toolshed's `browser` tool
(`~/secondBrain/70-79 Toolshed/tools/browser`) keeps a real Chrome profile that he logs into once
(`browser login`). Its cookies go to `~/.minami/browser/state.json` (0600). Minami's `readLink` sends
any walled or social link (Instagram, X, TikTok, Facebook, Threads, LinkedIn) through `browser view`
with those cookies. The screenshot joins the item's files, so Haiku sees the actual post. Verified on
his first Instagram link: "Saudi OpenAI employee arrested for planting spy device", read via the
browser. The dashboard's chats get the same cookies (§3, `MCP_SERVERS()` in `lib/agent/manager.ts`,
`--storage-state`, checked per session), plus a prompt line: view only, never post, like, follow or
DM unless asked in that chat.

> 🐛 **The login window flashed every 4 s.** `context.storageState()` collects localStorage by opening a
> page per origin. Saving it on a timer opened and closed tabs in front of him while he typed his
> password. Fix: save `context.cookies()` only, which opens nothing. These sites keep their sessions in
> cookies.

## Ranking — hot / warm / cold (`rank`)

A few readable terms, not a model:

- **recency:** 3-day half-life.
- **echo:** other items in the last 14 days that share a tag. This catches a theme building over days.
  It is capped at 4 echoes and weighs 0.8.
- **touch:** 🔥 adds 1, and each comment adds 0.3, up to 0.6.
- **fit:** +0.2 when the tagger named a concrete use in one of his projects (`why`). The prompt forbids
  generic ones ("informs market intelligence"), which it wrote at first.

Hot ≥ 0.9 or 🔥; warm ≥ 0.35; else cold. **Came back:** an item older than 14 days, untouched, that
shares a tag with something saved in the last 2 days is lifted to at least warm. That's the reason cold
items are kept, not deleted. **Themes** are tags seen at least twice in 30 days. The arrow compares the
last 3 days' rate with the 27 days before.

## The page

Hero (`N hot right now`, rising themes), the drop box (type, paste a screenshot, drag files, ⌘↵), then
Hot & warm · By day · Themes · Cold. A card has a thumbnail (its image, or the link's og:image), kind,
title, gist and tags. Tapping it shows his words, the "for you" line, the links, comments, 🔥 and Remove.
A failed read shows its error and **Try again** (`op: "retry"` → `ideas-add.mjs --retry`). The page polls
every 5 s while something is being read, otherwise every 30 s.

Media is served only for a file the item itself lists, resolved under `media/`; a traversal attempt is
a 404.

## Verified (2026-10-14)

On a scratch store (`MINAMI_IDEAS_DIR`) with a side server: a link (Shopify's BFCM checklist → "tool",
title and gist from the page), a meme GIF (vision got the reaction meme), a short thought, and a drop
from the page all read and tagged in ~10–30 s each. Ranking, themes, media and the traversal 404 checked
through the API; the page checked at desktop width. Auto-detect was checked offline on 11 sample
messages. **Not yet exercised: a real Slack DM**, including a file download through `files:read`.

## Next

- **Step 4 — morning seeds on Today.** After the 07:30 plan, 3 idea seeds drawn from hot items and
  rising themes, each citing its items. To-do adds it to Today, Keep writes a vault idea note, Drop
  removes it.
- **Then "thread jobs"** (queued in the vault's Minami note): @minami under a teammate's file → a
  dashboard chat does the heavy work → the result is posted back to the thread.

## Links to Today and Video Studio (2026-10-16, §30 nav revamp)

- **→ Today** posts `{op:"add", text, from:{href:"/ideas#<id>"}}` to `/api/today`, then marks the idea
  `sent.today` — only after the to-do landed, so a failed add never reads "On Today". `/ideas#<id>`
  opens and scrolls to that card and switches to "By day" so a cold item isn't hidden.
- **Make a video → Video Studio's own intake.** Video Studio (`~/tiktok-studio`) plans tomorrow's 5
  topics in the evening (`scripts/topic-plan.mjs`, launchd `com.thomas.video-evening`) from story
  cards in `harness/cards/<date>/<slug>/card.json` — the last two days' cards no locked plan has used.
  One story becomes a card with `node scripts/story-card.mjs card "<story or url>"`. So
  `POST /api/ideas/video {id}` (`lib/ideas.ts toVideo`) spawns exactly that, detached, seeded with the
  idea's first link (else title — gist), logs to `~/.minami/ideas-video.log`, and marks `sent.video`
  (the button becomes "Sent to studio"; a second tap is a no-op, so it never pays for two write-ups).
  It does **not** write the plan file: that file is shared with the Slack card's clock
  (`~/Minami/src/videoPlan.js`), and a hand-made slot would have no evidence behind it. The card
  competes on score with the night's news — it is a candidate, not a guaranteed slot.
  `VIDEO_STUDIO_DIR` overrides the checkout.
- **The shell's project filter** matches an idea's tags and the words of its `why` (ideas have no
  project field; the tagger names the project there).
- The page's own Today / Board links are gone (the shell's rail does that); `pb-28` clears the phone bar.
