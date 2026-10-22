# §31 Modules: folders that describe themselves

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

Asked for 2026-10-21/22. Thomas wanted goals, runners, the to-do list and whatever comes next managed as
**modules with a clear folder structure**. He wanted to be able to start a chat *inside* one and have it read
the right data, and he wanted it built to last ("ready for the unknown future").

## The idea in one line

**The folder is the product. The dashboard and Claude Code are today's readers, and both can be replaced.**
The design can't predict which tools come next. What it can do is depend on nothing a future tool might
lack: plain files, documented shapes, one writer, and a short note at the door.

## Where the rules come from

| Rule | Source |
|---|---|
| Files outlive apps; the UI is one disposable viewer | Steph Ango, *File over app*; Ink & Switch, *Local-first software* (2019): longevity, user control |
| The project owns its components; the runtime is frozen and swappable | Google Research **harness2** (`~/refs/harness2`): `harness.yaml` lists owned components (prompt, skills, memory, tools), never the runtime; per-runtime `SurfaceSpec` data says where each lands |
| Append events, derive state | Beads (Yegge) and BacklogIT: JSONL is the truth and any index is rebuildable; Anthropic, *Effective harnesses for long-running agents*: the progress log is "the only memory that survives" |
| One write path, never hand-edited | Our own 2026-10-21 duplicate TikTok posts (two writers, no lock → `~/tiktok-studio/scripts/lib/lock.mjs`) |
| Records in JSON, prose in Markdown | Anthropic: models are less likely to wrongly edit JSON |
| AGENTS.md at the door, kept short | AGENTS.md is the cross-tool standard (Linux Foundation AAIF; Codex, Cursor, Copilot and others). An ETH Zurich study (2026, secondhand) found context files cost ~20% more tokens for little gain, so put in only what the agent can't discover |
| Lessons kept with their evidence | harness2's `EXPERIENCE.md` ("never a summary") |
| Edits name only what they change | harness2's omitted-is-inherited edits; the same rule as the posting state fix |

## The shape

```
~/.minami/<module>/
  module.json      manifest: what this is, who writes it, which files exist and what they mean
  AGENTS.md        the door: only the non-discoverable facts, rules, commands (any agent)
  CLAUDE.md        one line, "@AGENTS.md" (Claude Code reads CLAUDE.md, not AGENTS.md)
  EXPERIENCE.md    lessons about the machinery, each with its evidence
  schema/*.vN.json JSON Schema per record kind; a new shape is a new file, never an edit
  bin/<module>     the CLI: reads, plus the module's one write path
  <data>           JSONL logs (truth) and JSON views (derived)
  skills/*/SKILL.md   optional: procedures, loaded only when used
```

**`module.json`, version 1:** `module`, `manifestVersion: 1`, `title`, `summary`, `door`, `cli`, `view`
(a dashboard path), `lessons`, `writer {who, code, schedule}`, `sources` (data the module reads but doesn't
own), `items` (per-item folder layout, files and their schemas). Paths may start with `~/`. The dashboard
reads the first eight fields; the rest are for agents.

## How "chat inside the module" works

`lib/modules.ts` lists every folder under `MINAMI_HOME` (default `~/.minami`) that has a `module.json` with
`manifestVersion: 1`. `POST /api/modules {op:"chat", id, ask?}` starts a new chat with **cwd = the module
folder**. Because cwd decides which CLAUDE.md, skills and memory load, the chat gets the module's rules
from the folder itself. No context is pasted into the prompt that could drift from the files. A chat opened in
that folder any other way, from a terminal or with another tool, knows exactly as much.

- **New chat per click**, key `module:<id>:<ms>`. Unlike "Resolve with Minami" (§29, one chat per goal per
  day), there's no single job to resume.
- With no `ask`, the opening message asks for where things stand in at most five lines, and to change nothing.
- **The dashboard never writes into a module.** It finds modules, shows them and opens chats.
- The button is `app/autopilot/ModuleChat.tsx` ("Chat here", beside the Goals heading). It moves to a shared
  component when a second page has a module.

## The pilot: Goals (`~/.minami/goals`, 2026-10-22)

Goals were already most of a module. Their data lived in one folder and had one writer (the vault runner
`goal.mjs`). **No data moved:** the runner, the heartbeat and `lib/goals.ts` read and write exactly what they
did before. Added beside the data:

- `module.json`: the writer is the runner; the goal spec is a `source`, because it stays in the vault note
  (the note is its source of truth, §29).
- `AGENTS.md` / `CLAUDE.md`: where each thing lives, the rules (never hand-edit `<id>/`, a rank is a number or
  null, ask before `run`), the commands.
- `schema/run.v1.json`, `rank.v1.json`, `today.v1.json`, written from the real files.
- `bin/goals list | status <id> | ranks <id> | run`. Reads go through `goal.mjs` itself, so they parse a
  goal exactly as the runner does.
- `EXPERIENCE.md`: three machinery lessons from §29. Lessons about *winning* a goal stay in the runner's
  own `<id>/playbook.json`, which already keeps helpful/harmful counts and evidence.

Checked: nothing enumerates `~/.minami/goals` as a list of goals (the runner and `lib/goals.ts` both list
goals from the vault notes), so `bin/` and `schema/` can't be mistaken for one.

## Next modules, in order

1. **Runners** (`~/.minami/automations`). launchd is the truth there (§27), so the module is mostly a door and
   a manifest.
2. **Today** (`~/.minami/today`). Its writers are the heartbeat and the page; the pilot for a module whose
   CLI is a real write path (validate → `lock.mjs` → append → fsync).
3. When a third module exists, the rail can list modules from `GET /api/modules`. Until then, the registry
   only backs "Chat here".

## Deliberately not now

- **MCP:** a CLI plus a skill does the same job without tool definitions on every turn. Wrap the same CLI in
  MCP if a tool needs it.
- **SQLite:** only as a cache rebuilt from the JSONL, and only when a query needs it.
- **A renderer** (harness2's per-runtime `SurfaceSpec`): the `@AGENTS.md` line covers Claude Code today.
  Build it when a second runtime needs something AGENTS.md can't say.
- **llms.txt:** it's for web crawlers, and 2026 data says AI tools mostly don't read it.

## Open

- `~/.minami` isn't under version control, so a module's door files have no history. Candidate: `git init`
  each module folder with its data `.gitignore`d, or keep the door files in the vault.
