# §35 · Growth — traffic → signup → paid by source, from PostHog, daily

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

A page at **`/growth`** (rail: Day → Growth; phone: More) for reading the site's funnel the way a growth
manager does: how many came, from where, how many signed up, how many paid. It is daily, not live. Picked
on the pitch bench (`~/ecvision/pitches/posthog-growth`, round 4 **F2 "Source ledger, with totals"**,
2026-10-24) after three rounds. Round 1 was too wordy ("less talk more visualisation"). He then picked the
wave (A) and named the focus ("Traffic > sign up > paid + filter by traffic source"), and refined F.

## What's on it

1. **Totals:** four cards, Traffic → Signups (% of traffic) → Paid (% of signups) → Visit → paid
   ("1 in N visitors pays"). Each card has its change against last week.
2. **The days:** 14 days of traffic for the picked source, with daily signup bars under it (◆ marks a day
   a payment landed). The last point is today, which is partial, so it is dashed.
3. **The ledger:** one row per source (traffic + share, signups + rate, paid, visit → paid), then **All
   sources**. **A row is the filter:** tap one and the cards and the days follow it. When a source is
   picked, the change line becomes its share of all traffic and of all signups instead.

## Rules the numbers follow

- **Colour only on a real move.** A change is green or red only past ±10%, and only when both weeks
  have at least 50 (`MIN_N`). Otherwise it is grey with "too few", so 3 → 5 never reads as +67%.
- **A partial last week isn't compared.** If PostHog's data starts inside last week's window, the change
  says "only N days of data" in grey. On 24 Oct 2026 the first data was 15 Oct, which made the
  raw week-on-week +20% for visitors and +117% for page views.
- **Untracked is said, not hidden.** With no signup or payment event, those cards show an amber "?" and
  "not tracked yet". The page footer names the env vars to set.

## How the data gets here — `lib/growth.ts`

- **Once a day, cached on disk.** `getGrowth()` returns `~/.minami/growth.json` (`MINAMI_GROWTH_FILE`)
  when it was pulled today (local date). Otherwise it pulls first. There is no cron: the first open after
  midnight pulls. `POST /api/growth` (the "↻ Pull now" button) forces a pull. Only one pull runs at a
  time (`inflight`), so the phone and the desktop opening together don't double the queries.
- **Read-only HogQL** over `POST {host}/api/projects/{id}/query/` with a personal API key. Five queries
  per pull: the events seen in 90 days, daily-by-source, week-and-prev-by-source, week-and-prev total,
  and the top `$host`.
- **Uniques per window, never summed from days.** The week's visitors is its own `uniqIf`, because
  summing daily uniques counts a person who came on three days three times. The All row is its own query
  for the same reason, so source rows can add up to more than All (one person, two sources).
- **First-touch attribution.** The source is the person's `$initial_referring_domain`, else the event's
  `$referring_domain`, else `$direct`. A person's visit, signup and payment therefore land on the same
  row, and the ledger's rates are coherent. `sourceName()` maps domains to names (Google, Bing,
  LinkedIn, ChatGPT…). It drops `localhost`, `127.*` and the site's own domain, and the queries skip
  events whose `$host` is local.
- **Event names.** These come from `MINAMI_GROWTH_SIGNUP_EVENT` / `MINAMI_GROWTH_PAID_EVENT`. If those
  are unset, the first common name that PostHog has seen in 90 days is used (`SIGNUP_GUESS`,
  `PAID_GUESS`). Names are stripped to `[\w $.:-]` before going into HogQL.
- **Config.** `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` and `POSTHOG_API_HOST` (default
  `https://us.posthog.com`) are read from env. Failing that, they come from `KEY=VALUE` lines in
  `MINAMI_GROWTH_ENV_FILE`. On the author's box that is ecvision's own `~/.config/ecvision/seo.env`, so
  the key lives in one place.
- **A failed pull keeps the last good one on screen,** with the error above it. It never shows a blank
  page.

## State on 2026-10-24

The project is ecvision.ai (PostHog 663877, UTC), with data since 15 Oct. This week (17–23 Oct): 30
visitors. First touch gives Direct 26, Google 4 and Bing 1. ecvision sends only `$pageview` and
`$identify`, so signups and paid are "not tracked yet" until it sends a signup event (and a paid one).
The internal-traffic filter is off in PostHog. Most Direct traffic is probably the team (Vietnam).

## Not built (yet)

- A one-line Growth card on Today (sketched on the moodboard).
- A per-source change against last week (only the All row compares weeks).
