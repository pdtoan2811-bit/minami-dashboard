# Account identity

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 6. Account identity — `app/api/accounts`

**Never trust `token-slayer status`'s `active` field.** It echoes a label written on the last switch
*attempt*; it is not evidence the switch took.

> 🐛 **Silently billing the wrong account.** On 2026-07-29, `state.json` claimed
> `preferred@example.com` while the real OS-keychain credential was `other@example.com`. Every
> session that day ran on the wrong account with the CLI cheerfully reporting otherwise.

Ground truth is `~/.claude.json`'s `oauthAccount.emailAddress`, written by Claude Code from the
credential it actually authenticated with. `/api/accounts` layers a `live` block carrying that, plus
`offPreferred` and `claimsMismatch`. `AccountStatus` triggers on it and **re-verifies after
switching** rather than believing the CLI's reported success.

### The preferred account is chosen in Settings, and lives on disk

`lib/preferred-account.ts` stores it in `~/.minami/account.json` (override: `MINAMI_ACCOUNT_CONFIG`).
It cannot be a `useSetting` — the thing that reads it is this API route inside next-server, which has
no browser to ask, and `AccountStatus` is mounted globally in `app/layout.tsx`. Same reasoning as
`lib/autopilot/config.ts`. Read per-request, so a change in Settings lands on the next 30s poll.

Precedence is **file → `MINAMI_PREFERRED_ACCOUNT` → built-in fallback**, deliberately in that order.
Env-var-wins is the obvious alternative and it's wrong: on any machine that sets the var, the
Settings control would silently do nothing, which is a dead switch that costs an hour to diagnose.
The env var is a seed for a fresh install; once you pick an account, your choice is the answer.
`live.preferredPinned` distinguishes "someone chose this" from "nobody has, this is the fallback".

**The built-in fallback is empty, and has to stay empty.** This file is checked in, so anything
written there ships to every clone. It named the author's address until 2026-07-31, which meant a
stranger's first run raised a permanent wrong-account alert measured against an email they had never
heard of and could not log into — an alarm with no reachable all-clear. Empty makes the check
**dormant rather than broken**: `offPreferred` is now `preferred !== "" && …`, on the reasoning that
with no preferred account there is no such thing as being off it. Choosing one in Settings arms it.

This cost the author nothing, which is the tell that it was always the right shape: the real choice
was never in the repo — it's in `~/.minami/account.json`, where a personal answer belongs. A default
that only works for one person is a default that should not have been compiled in.

`PreferredAccountPanel` renders **three** states, not two. "No account chosen" is not "you match",
and reporting *"live credential matches the preferred account"* when there is no preferred account
is an all-clear nobody asked for.

**Two verbs, kept apart on purpose.** `POST` switches the live credential — a side effect that
rewrites the shared Keychain entry and kills every running `claude` on the box. `PUT` only records
which account *should* be live. Conflating them would mean picking a target in Settings silently
dropped your sessions. `PUT` also rejects any address not in the token-slayer pool, because a typo
would pin the alert to an account that can never go live, leaving it stuck red with no way to read why.

### The model alert has two halves, and only one of them was ever built

`/api/accounts` carries the model check as well as the account check, because they answer the same
question — *is this box spending what I think it's spending?* — and share one card. As of 2026-09-07
it reports both halves of it:

- **Config: `checkModelPins()`** (`lib/model-pins.ts`) — what each spawner will run on its **next**
  spawn. Rows for the Minami bot and the dashboard, each compared against `PINNED_MODEL`.
- **Runtime: `liveModels()`** (`lib/agent/manager.ts`) → `live.premiumSessions` — sessions **already
  running** on a premium model. Filtered to the premium ones only; this is an alert feed, not a
  session census. It reports `observedModel` where the SDK has told us one and the requested id before
  the first `init` lands, so a pane about to run Fable shows up immediately rather than one message
  later.

The split is not tidiness. A `query()` is built around a model and cannot be re-modelled warm (§3), so
**a session born on Fable keeps it until something respawns it** — the config check can read perfectly
green while a pane burns 2× Opus for hours. That is not a hypothetical; it happened on 2026-09-03.

> 🐛 **The drift check compared the config against itself.** `checkModelPins()` compared
> `DASHBOARD_MODEL !== PINNED_MODEL` and `brain !== PINNED_MODEL` — every row measured against the pin,
> so all of them go green together the moment the pin itself moves. And `PINNED_MODEL` is an env var:
> `MINAMI_PINNED_MODEL=claude-fable-5-1` was **undetectable by construction**, because the check would
> compare Fable to Fable and report no drift. An env var inherited from a stale parent shell is exactly
> how this drifts without a code change — `lib/canvas-modes.ts` records the same failure for the STT
> ear, where `git diff` was clean for weeks.
>
> Fix: `EXPECTED_MODEL` in `lib/model-catalog.ts`, a **literal**, deliberately not derived from anything
> overridable — the fixed point that makes *"did the pin itself move?"* an answerable question. A
> **"Box pin"** row now sits above the others and is checked against it, with `source` naming whether
> the value came from the env var or the file, so the alert says which thing to edit.

`checkModelPins()` also returns `premium: true` when a *drifted* spawner is on a Fable-family id.
Drift onto Fable is its own severity rather than one more drift: it is the only direction that costs
2× Opus per token, and it must never fold into a collapsed chip.

**`AccountStatus` escalates a live premium session to `critical`.** Normally model drift stays at
`warn` however long it persists, because it is always fixable by editing a file — while account drift
takes `critical` only when self-recovery is untrustworthy. A busy premium pane breaks that ranking on
purpose: unlike a config finding, which costs nothing until the next spawn, **it is already billing**.
`premiumBurning` (any `premiumSessions[].busy`) forces `critical`, which means the pulsing dot and, via
the existing warn→critical rule, re-opening a card you had collapsed.

`episodeKey` folds the live sessions in **keyed by `cwd + model`, not by count** — a second pane joining
an existing Fable episode is new information and should re-expand a collapsed card. The rows name the
**folder**, not the pane key: the folder is what you recognise and what you'd go click on. There is
deliberately no button, because switching another pane's model from a status widget would respawn
someone else's conversation mid-thought.

### Caveats
- `premiumSessions` and `models` are both **optional** in the client type. A dashboard build older than
  either check simply doesn't send them, and absence is treated as "nothing to report" rather than
  "no drift" — absent evidence isn't evidence.
- The runtime half sees only sessions **this server process** is hosting. A `claude` started in a
  terminal is invisible to it; that is what `server/metrics-server.js`'s cost panel is for — and as of
  2026-09-07 that panel prices `claude-fable-5-1` before `claude-fable-5` (its `priceFor()` matches by
  substring, so the shorter id listed first swallowed every 5.1 turn) and books an unknown
  `/fable/i` id at the premium rate rather than at Opus's, which used to under-report a premium tier by
  half in the very panel you'd use to notice one.
- There is no shipped fallback any more (see above). If nothing is pinned and no env var is set, the
  wrong-account check is **off** — deliberately, but it does mean "no alert" can mean "not
  configured" as well as "all good". `PreferredAccountPanel` says which.
- `oauthAccount.displayName` goes stale across switches (read "OE Dev" while every UUID said
  `other@example.com`). Use the UUID/email fields; the display name is cosmetic.
- token-slayer's stored slot for a pooled account can be a **degraded capture** (`oauth_account`,
  `plan`, `refresh_token_expires_at` all null) *even while that account is live* — it then can't
  proactively refresh, so the silent-expiry outage recurs. Not fixable from this repo.

> 🐛 **A dead account reported `READY` for ten hours.** On 2026-07-31 every session failed with
> *"Failed to authenticate: OAuth session expired and could not be refreshed"* while `tok status`
> showed that slot as `READY`, so the account looked healthy and the error looked like it came from
> somewhere else. It was a degraded capture of exactly the kind above: added 2026-07-30
> 14:44 with `uuid`, `plan`, `oauth_account` and `subscription_type` all null and
> `refresh_token_expires_at` literally `null`; made active at 15:50; its access token expired at
> 22:43 and the refresh was rejected.
>
> `READY` is derived from `needs_reauth`, which is written when an account is **added** and never
> revised when a refresh actually fails — so the row cannot report the one failure that matters.
> `tok sync` re-reconciles and flips it (`READY` → `REAUTH`), which is the diagnostic step worth
> reaching for first; recovery then needs an interactive `tok add <email> --login`.
>
> This is the same lesson as the 2026-07-29 bug at the top of this file, one level down: that one was
> token-slayer's *active* label disagreeing with the keychain, this one is its *health* label
> disagreeing with the server. Both say the same thing — its state file records intent, not outcome.

---
