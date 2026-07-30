# Account identity

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 6. Account identity — `app/api/accounts`

**Never trust `token-slayer status`'s `active` field.** It echoes a label written on the last switch
*attempt*; it is not evidence the switch took.

> 🐛 **Silently billing the wrong account.** On 2026-07-29, `state.json` claimed
> `oedevai2@gmail.com` while the real OS-keychain credential was `pdtoan2811@gmail.com`. Every
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

**Two verbs, kept apart on purpose.** `POST` switches the live credential — a side effect that
rewrites the shared Keychain entry and kills every running `claude` on the box. `PUT` only records
which account *should* be live. Conflating them would mean picking a target in Settings silently
dropped your sessions. `PUT` also rejects any address not in the token-slayer pool, because a typo
would pin the alert to an account that can never go live, leaving it stuck red with no way to read why.

### Caveats
- The shipped fallback in `preferred-account.ts` is **hand-synced with the pool**. `tok setup` can
  remove an account, and a fallback naming a deleted one makes the panel flag every healthy session
  as wrong-account. Pin a real choice in Settings rather than relying on the fallback.
- `oauthAccount.displayName` goes stale across switches (read "OE Dev" while every UUID said
  `pdtoan2811`). Use the UUID/email fields; the display name is cosmetic.
- token-slayer's stored slot for a pooled account can be a **degraded capture** (`oauth_account`,
  `plan`, `refresh_token_expires_at` all null) *even while that account is live* — it then can't
  proactively refresh, so the silent-expiry outage recurs. Not fixable from this repo.

---
