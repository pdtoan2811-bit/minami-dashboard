---
name: bento-icons
description: Assign, fix, or semantically infer the icons shown on a Minami Bento topic — both its big 3D topic icon (tile + rail) and its brand/tech icon row. Use when the user wants to "set the icon for a project", "this new topic got a generic icon", "add the Slack/BigQuery/etc icon", "these icons are wrong", or "figure out what tech this project uses and show it". Reads/writes the same icon store the Bento app reads.
---

# Bento Icons — assign & semantically infer a topic's icons

Two different things, one store:

| What | Where it shows | Source |
|---|---|---|
| **Topic icon** — one big 3D glyph | the tile, the collapsed rail, the chat header | `icon` in the assignment store → keyword match on the folder name → a hash-picked distinct glyph |
| **Tech icons** — a row of brand marks | the tile, the chat attach bar | `icons`/`primary` in the store, merged with auto-detection |

## Set a topic's 3D icon (the one you aim at when switching)
This is the fix when a new topic shows a glyph that says nothing about it. Add `icon` to its entry in
`~/.minami-bento/icons.json`:

```json
{ "ecomIntel": { "icon": "chart", "icons": ["shopify", "clickhouse"] } }
```

- Valid values are **filenames in the app's `public/icons/`** (no extension, no `-dyn` suffix):
  `ls ~/minami-dashboard/public/icons | sed 's/-dyn//;s/\.webp//' | sort -u`
  — ~180 of them: `rocket bulb chart notebook money-bag lock setting tools chat puzzle color-palette
  link mobile lab target megaphone calendar explorer video-cam music map-pin folder trophy crown …`
- Pick for **recognition at 20px**, not for cleverness — the icon's job is to be the thing the eye
  aims at in a rail of six, so distinctness from its neighbours beats a subtle metaphor.
- An unknown slug renders the inferred icon instead of a broken image, so a typo degrades quietly —
  check the tile after writing.
- No entry needed when the inferred one is already right: the folder name is keyword-matched first
  (`data|analytic|dashboard…` → `chart`, `ai|agent|llm…` → `bulb`, and ~25 more), and anything that
  matches nothing gets a stable hash-picked glyph rather than a shared default.

## The two stores

1. **Assignments** — `~/.minami-bento/icons.json`, keyed by project name (its folder basename) or its
   absolute cwd. This is the source of truth you curate:
   ```json
   {
     "acme-web":        { "icon": "money-bag", "primary": "shopify", "icons": ["shopify", "clickhouse", "googlebigquery"] },
     "/Users/me/infra": { "icon": "setting", "icons": ["terraform", "amazonwebservices", "kubernetes"] }
   }
   ```
   `icon` is the big 3D topic glyph (a `public/icons/` filename); `icons`/`primary` are tech slugs.
   Assigned icons are shown **first**, then auto-detected ones, de-duplicated. `primary` (optional)
   leads the list.

2. **Icon SVGs** — `public/tech-icons.json` in the app repo, generated from
   [simple-icons](https://simpleicons.org) by `bin/build-tech-icons.mjs`. Any slug you assign that
   isn't in here still renders as a **lettermark tile** (so nothing breaks), but for a real logo it
   must exist here.

## Assign icons to a project
1. Read `~/.minami-bento/icons.json` (create it if missing — it's a plain JSON object).
2. Add/adjust the project's entry with a list of **slugs** (see "Finding slugs" below).
3. Write it back. The app picks it up on its next refresh — no restart needed.

## Semantically infer icons (when detection found nothing)
When a project has no detectable stack (e.g. a notes vault, a design folder, a data project driven by
SQL files), infer a sensible set from what the project is actually about:
- Look at the cwd name, README, file types, and the session topics/tasks for that project.
- Pick 2–6 slugs that represent its real tools (e.g. a BigQuery + dbt analytics repo →
  `["googlebigquery", "dbt", "clickhouse"]`; a Shopify app → `["shopify", "nextdotjs"]`).
- Write them to the project's `icons` in the store.

## Finding slugs
- Valid slugs = the keys of `public/tech-icons.json` (≈160: clouds, data stores, langs, frameworks,
  office tools like `googledocs`/`googlesheets`/`googlemeet`/`slack`, etc.).
- The slug is the [simple-icons](https://simpleicons.org) slug, lowercased, no spaces
  (e.g. Google BigQuery → `googlebigquery`, Next.js → `nextdotjs`, ClickHouse → `clickhouse`).

## Add a brand icon that doesn't exist yet
If a needed brand isn't in `public/tech-icons.json` and isn't shipped by simple-icons
(trademark-removed ones like Slack/OpenAI/MS-Office render as lettermarks by default):
1. Add it to `bin/extra-icons.json` as `"slug": { "title": "Name", "hex": "RRGGBB", "path": "<svg d>" }`.
2. Run `node bin/build-tech-icons.mjs` to regenerate `public/tech-icons.json`.
3. Reference the slug in the project's assignment.

## Rules
- **The app reads the store live** — no restart, no rebuild. Refresh the tab and the icon is there.
- Keep each project to a **focused** set (≤ ~6) — the tile has little room; lead with what matters.
- Prefer real detected tech; only hand-assign what detection can't see or to reorder.
- Never invent a stack a project doesn't use — infer from real evidence (files, deps, topics).
