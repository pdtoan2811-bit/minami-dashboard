# The module map and the KB itself

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 7. Module map — `lib/module-graph.ts`

The `/architecture` graph is **hand-maintained data, extracted from source**. Static edges come from
`from "..."` specifiers, runtime edges from `fetch()`/`EventSource()` string literals naming an
`/api/` path. The extraction script is in the file header — re-run it after a refactor.

> ⚠️ **This is the one thing here that can silently go stale.** Everything else describes behaviour
> that fails loudly when wrong; a missing edge just quietly isn't drawn. If you add a module, add it
> to `NODES`/`EDGES` in the same turn.

---


## 7b. The knowledge base itself

Four parts: the hub (`public/kb/index.html`), the visual explainer
(`public/kb/architecture.html`), this record, and the module map data. Ported from
`~/dataAnalyticsOwnego` (`toolkit/hub` + `queries/QUERIES.md` + the `query-docs` skill).

The pages share `kb.css` and `kb.js` rather than each carrying its own copy of the chrome. The
"one file, zero dependencies" rule that governs a *standalone artifact* is the wrong call here —
these pages ship together in one directory, and seven copies of 250 lines of CSS drift. Still zero
dependencies: no build step, no framework, no web fonts. Same call `~/dataAnalyticsOwnego` makes
with `toolkit/brand/tokens.css`.

**Page set** (`PAGES[]` in `index.html` is the only place to edit):

| Page | State |
|---|---|
| `architecture.html` — the whole system | shipped |
| `transcripts.html` — pipeline 1: disk → parser → tile | shipped |
| `live-sessions.html` — pipeline 2: browser → SDK → claude | shipped |
| `metrics.html` — pipeline 3: two machines, one collector | shipped |
| `operations.html` — deploy · identity · runbook | shipped |

**The page set is complete.** Every pipeline has a deep dive, plus a system overview and a runbook.

**Known gap:** `live-sessions.html` predates the browser panel rebuild (§5b) and says nothing about it.
The panel is a substantial part of pipeline 2 now — the result-text parsing, the two image sources, the
agent-driving toolbar — and it earns diagrams (the markdown-section parse, and the
inline-base64-vs-disk-file decision). Not written yet; §5b is the only record. No hub card has been
added for it, because there is no page to link to.

Every page carries the shared top nav (`KB.nav()`), so no page is a dead end and unwritten pages
show as visible-but-unclickable placeholders. **Light is the default theme**, deliberately — there is
no `prefers-color-scheme` rule, matching `~/dataAnalyticsOwnego`'s hub ("light by default"), so the
KB looks identical on every machine and screenshots of it are reproducible. Dark is opt-in via the
toggle and remembered across pages.

**Two ways to read it**, and the difference matters:

| | URL | Needs the app? |
|---|---|---|
| Served by Next | `localhost:3000/kb` | yes |
| Standalone | `localhost:4400` (`npm run kb`, or double-click `Open Knowledge Base.command`) | no |

The standalone server exists because `bin/serve.sh` tears :3000 down on every deploy and refuses to
restart while a turn is in flight — so the docs would be unreachable exactly when something is
broken, which is when you most want them. Zero dependencies, resolves its own root from
`import.meta.url`, walks the port up on `EADDRINUSE`.

The hub calls `/api/state` to learn which mode it's in. Only the standalone server answers; from
Next it 404s, and that failure *is* the signal that relative links already resolve. When standalone,
cards marked `needsApp` get rewritten to the app's real origin, or greyed out with "needs the app
running" if :3000 isn't listening.

### `CLAUDE.md` is split by machine, and the skills ship with the repo

`CLAUDE.md` is the one file Claude loads automatically in any checkout, so it is the entry point a
stranger's agent actually gets. It used to describe only *this* machine: it addressed Thomas by name,
opened with "you are running inside a dashboard chat pane — which you almost always are", pointed at
`~/.minami/deploy.log` and `Redeploy Minami.command`, and named the `minami-kb` skill, which lived in
`~/.claude/skills/` and was therefore absent from the clone. A fresh clone's Claude was told to
follow a deploy protocol for a server that wasn't running and to use a skill that didn't exist, and
was never told the one thing it needed — that `npm run dev` is how you start the app.

It is now two parts with a one-line test at the top (`test -d ~/.minami`). **Part 1** is true in any
clone: how to run it, `build:check`, the three pipelines, the conventions, the record. **Part 2** is
fenced off as the author's box only: the in-process session host, `deploy.sh --detach`, the
shared-checkout rules.

The split is by *machine*, not by audience, because that is the thing that is actually different. A
contributor and Thomas want the same conventions and the same knowledge record; what they do not
share is a server that dies when you rebuild it.

`minami-kb` now ships in `.claude/skills/` alongside `minami-flow`, `bento-icons` and
`bento-taxonomy`, with its paths made repo-relative (the personal copy linked
`../../../../minami-dashboard/docs/KNOWLEDGE.md`, which only resolves from `~/.claude/skills/`) and
its `minami-sync` / vault references dropped. The rule the record depends on — *any turn that changes
a subsystem updates that subsystem's file in the same turn* — is only enforceable if the skill
carrying it is in the checkout.

> 🐛 **The KB server quietly stole the dashboard's port.** It read `process.env.PORT`, which is
> already spoken for here — `bin/serve.sh` sets it, and it's often exported in the shell. It bound
> `127.0.0.1:3000` *alongside* the dashboard's IPv6 wildcard (macOS permits that pairing rather than
> raising `EADDRINUSE`), so requests to `localhost:3000` split between two servers at random. Now
> reads **`KB_PORT`** only, and refuses to start if that equals the app's port.

---
