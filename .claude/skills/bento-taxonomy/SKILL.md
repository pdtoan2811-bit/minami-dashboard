---
name: bento-taxonomy
description: Maintain and improve the Project > Goal > Task taxonomy that Minami Bento uses to organize Claude Code sessions. Use when the user wants to re-label sessions, fix a wrong goal/task, define the goals for a project, or "improve the bento grouping / titles". Reads the same store the Bento app reads.
---

# Bento Taxonomy — Project › Goal › Task

Minami Bento (`/bento`) groups every local Claude Code session into a three-level hierarchy:

- **Project** — deterministic, from the session's working directory (`cwd`). Never invented.
- **Goal** — a mid-level *objective within a project* that groups related sessions
  (e.g. `secondBrain` → "Bento UI", "Minami infra", "Memory hygiene"). Curate these over time.
- **Task** — what one session is actually doing (4-7 words, concrete). One per session.

## The store (source of truth)
`~/.minami-bento/cache.json` — a JSON object keyed by session id:

```json
{
  "<session-id>": { "messages": 947, "goal": "Bento UI", "task": "Add project-goal-task hierarchy" }
}
```

The Bento app reads this and renders it. It is **auto-seeded by Haiku** (`lib/bento-enrich.ts`) for any
session missing an entry, and **only missing entries are filled** — so your hand edits are never
clobbered. This is what "gradually improve" means: edit `task`/`goal` here and the grid updates.

## How to improve the taxonomy (what this skill does)
1. **Read** `~/.minami-bento/cache.json` and the current sessions (`GET /api/bento/sessions`, or read
   `~/.claude/projects/*/*.jsonl` directly).
2. **Consolidate goals per project** — merge near-duplicate goals to one canonical name
   (e.g. "Bento", "Bento grid", "Bento UI" → "Bento UI") and reassign sessions to it.
3. **Fix bad tasks** — rewrite any vague/generic `task` into a concrete action title.
4. **Write** the updated map back to `~/.minami-bento/cache.json` (preserve `messages`).
5. Keep goals few and stable per project (aim ≤ ~6) so the hierarchy stays legible.

## Rules
- Never change a session's project (it's derived from cwd).
- Prefer reusing an existing goal over coining a new one.
- Tasks are specific and human; goals are short and reusable.
- To force a session to be re-labeled by the model, delete its entry from the store.
