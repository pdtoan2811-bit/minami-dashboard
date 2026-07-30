---
name: minami-kb
description: Keep Minami Bento's knowledge record in sync with the code. Use whenever work touches this repo — a subsystem is changed, a bug is found or fixed, a module is added/renamed/deleted, a default or env var changes, or a deploy step changes. Also use when asked what a part of the dashboard does, why it's built that way, what changed, or to record a decision or incident. Covers docs/KNOWLEDGE.md (the index), docs/knowledge/*.md (the material), public/kb/, lib/module-graph.ts.
---

# minami-kb — the living record of Minami Bento

[`docs/KNOWLEDGE.md`](../../../docs/KNOWLEDGE.md) is the authoritative reasoning record for this
repo. `README.md` says how to run it; the record says **why it is shaped the way it is** and what
already broke. The knowledge base has these parts:

| Part | Path | Holds |
|---|---|---|
| Front door | `public/kb/index.html` | card index of everything written |
| Visual explainer | `public/kb/architecture.html` | the diagrams |
| **Index** | `docs/KNOWLEDGE.md` | data flow · subsystem status · **the directory** · the cross-cutting lesson |
| **Living record** | `docs/knowledge/*.md` | one file per subsystem: mechanics · gotchas · 🐛 post-mortems |
| Changelog | `docs/knowledge/CHANGELOG.md` | dated entries, newest first |
| Module map data | `lib/module-graph.ts` | nodes + edges behind `/architecture` |
| Standalone server | `public/kb/serve.mjs` | serves the KB without the app |

**Read the index first, then one file — never the whole corpus.** It was a single 2,507-line file
(~46k tokens) until 2026-07-30, which cost a quarter of a session's context to answer a question
about one module, so the rational move became not reading it at all. The index is ~2.4k tokens and
its directory tells you exactly which file to open.

**`§` numbers are stable ids, not positions.** Roughly 25 code comments, `bin/deploy.sh` and the
`minami-flow` skill cite `§5e` / `§8` / `§12`. They survived the split and must keep surviving: give
a new section the next free number, and **never recycle or renumber one** without fixing every
citation (`grep -rn "§N" --include="*.ts" --include="*.tsx" --include="*.md" --include="*.sh"`).

**Opening it:** `npm run kb` → <http://localhost:4400>, or double-click `Open Knowledge Base.command`.
Also at `localhost:3000/kb` when the app is up. Prefer the standalone server while debugging — the
docs stay readable while `:3000` is down, which is when you need them. The port env var is
**`KB_PORT`**, never `PORT` (that one belongs to the Next server).

## The rule

**Any turn that changes a subsystem also updates this documentation — in the same turn, before
reporting back.** Never leave it for later; a doc that lags is worse than no doc, because the next
session trusts it.

Applies to: changing a subsystem's mechanics, adding/renaming/deleting a module, changing a default
or env var, finding or fixing a bug, changing a deploy step, or making a design decision worth
remembering.

## Procedure

### 1. Find the owning file, then edit its section
Open `docs/KNOWLEDGE.md`, read **The directory**, and open the one file that owns the subsystem you
changed. Each numbered section carries: what it is, **Mechanics**, **Gotchas**, and — where earned —
a `> 🐛` callout. Revise what the change touched. Don't rewrite unrelated sections; keep the diff
reviewable.

Edit an existing section rather than starting a new one for something that belongs in it — the split
exists to keep these files readable, and a file that grows a section per change undoes it. If a file
passes ~500 lines it has become the thing this split was fixing; say so rather than adding to it.
(`05e-shell.md` is already there, at ~9.1k tokens, and the directory labels it honestly.)

### 2. If it was a bug, write the post-mortem
Add or update a `> 🐛` callout describing **what broke, how it presented, and why** — not just the
fix. The failure mode is the valuable part; anyone can read the diff.

If the fix was user-reported, say so: *Reported by user: "<the symptom in their words>"*.

### 3. If a module changed, update `lib/module-graph.ts`
This is the one artifact that goes stale **silently** — a missing edge just isn't drawn. Re-run the
extraction script in that file's header rather than editing from memory:

```
python3 - <<'EOF'
import os,re
SKIP={"node_modules",".next",".next-dev",".next-uitest",".git","docs",".playwright-mcp"}
imp=re.compile(r'from\s+["\']([^"\']+)["\']')
api=re.compile(r'(?:fetch|EventSource)\(\s*[`"\']([^`"\']*?/api/[^`"\'?]*)')
for base in ("app","components","lib"):
  for d,dirs,fs in os.walk(base):
    dirs[:]=[x for x in dirs if x not in SKIP]
    for f in fs:
      if not f.endswith((".ts",".tsx")): continue
      p=os.path.join(d,f); s=open(p,encoding="utf8",errors="replace").read()
      print(p, sorted({m[2:] for m in imp.findall(s) if m.startswith("@/")}), sorted(set(api.findall(s))))
EOF
```

### 4. Update the subsystem status table
If a subsystem's state changed (shipped / partial / not written), update the table in
`docs/KNOWLEDGE.md`.

### 5. Add a changelog entry
In **`docs/knowledge/CHANGELOG.md`** — not in the subsystem's file, and not in the index. Newest date
first, using **absolute dates** (`2026-07-29`), never "today".

```
- **<subsystem>** — what changed, in one sentence. Why, if not obvious.
  *Reported by user: <the symptom>* — when the change came from a user-reported bug.
```

### 6. If you added a doc, add its row to the directory
A new file under `docs/knowledge/` must appear in **The directory** table in `docs/KNOWLEDGE.md`,
with the `§` ids it owns and a one-line description. A file nobody can reach from the index does not
exist — same rule as the hidden flow gear that nobody could find.

### 7. Add a hub card for anything new and readable
New surface worth linking → append to `CARDS[]` in `public/kb/index.html`. Individual subsystem docs
do **not** get their own cards; the record has one card pointing at the index.

## What belongs where

| Goes in `docs/knowledge/<subsystem>.md` | Goes elsewhere |
|---|---|
| Why a subsystem is shaped this way | Install/run/env → `README.md`, `SETUP.md` |
| Gotchas that would silently break on edit | Metrics setup → `server/README.md` |
| Bug post-mortems and failure modes | Diagrams and walkthroughs → `public/kb/architecture.html` |
| Caveats that would mislead a future session | Deploy protocol → `docs/DEPLOY.md` |
| | Dated "what changed" → `docs/knowledge/CHANGELOG.md` |

Only four things go in `docs/KNOWLEDGE.md` itself: the data-flow diagram, the subsystem status table,
the directory, and a lesson that generalises across subsystems (there is currently exactly one — "the
pattern behind the incidents"). Everything else belongs in a subsystem file. Keeping the index small
is the whole point; it is the one file every session pays for.

Cross-reference rather than duplicate.

## Rules

- **Never claim something is shipped without verifying it.** Run it, curl it, or say plainly that
  it's written but unverified. `next build` exiting 0 is not evidence the server swapped.
- **Record the reasoning, not the diff.** The value is why the obvious alternative was rejected.
- **Keep caveats blunt.** "Local-only, will show nothing on Vercel" beats hedged phrasing.
- **Preserve the incident list.** The 🐛 callouts are the most valuable content in the record —
  they're why the code looks over-engineered. Never prune them for brevity. If a file gets long,
  **split it and add a directory row**; never solve length by deleting post-mortems.
- **Match the house voice:** concrete, direct, no hype. Lead with the failure, then the fix.
- Docs under `docs/` are read from disk and need no rebuild. Only edits to `public/kb/` are served by
  the Next app, so those follow whatever deploy path your setup uses (`CLAUDE.md` Part 2 on the
  author's box; nothing at all if you're running `npm run dev`).

## Related

`minami-flow` — when to isolate, merge and ship in a checkout shared by several agents.
