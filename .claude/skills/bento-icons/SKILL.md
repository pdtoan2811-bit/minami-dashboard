---
name: bento-icons
description: Assign, fix, or semantically infer the brand/tech icons shown on a Minami Bento topic (its tile and chat attach bar). Use when the user wants to "set the icons for a project", "add the Slack/BigQuery/etc icon", "these icons are wrong", or "figure out what tech this project uses and show it". Reads/writes the same icon store the Bento app reads.
---

# Bento Icons — assign & semantically infer tech/brand icons

Minami Bento shows brand icons (GitHub, Shopify, ClickHouse, BigQuery, Google Cloud, Slack, …) on
each topic's tile and in its chat attach bar. Icons are **detected automatically** from the project's
`.git/config`, `package.json`, and config files — this skill lets you **curate** them: add what
detection missed, lead with the important ones, or infer icons for a project that has none.

## The two stores

1. **Assignments** — `~/.minami-bento/icons.json`, keyed by project name (its folder basename) or its
   absolute cwd. This is the source of truth you curate:
   ```json
   {
     "acme-web":        { "primary": "shopify", "icons": ["shopify", "clickhouse", "googlebigquery"] },
     "/Users/me/infra": { "icons": ["terraform", "amazonwebservices", "kubernetes"] }
   }
   ```
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
- Keep each project to a **focused** set (≤ ~6) — the tile has little room; lead with what matters.
- Prefer real detected tech; only hand-assign what detection can't see or to reorder.
- Never invent a stack a project doesn't use — infer from real evidence (files, deps, topics).
