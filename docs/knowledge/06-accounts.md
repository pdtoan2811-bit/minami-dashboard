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

### Caveats
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
