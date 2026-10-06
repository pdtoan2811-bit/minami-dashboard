# Token economics — where this box's usage actually goes

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 16. Token economics — measured, not assumed

**Read this instead of loading the `claude-api` skill.** That skill inlines its whole `shared/` tree
plus a language directory — **~137,000 tokens** measured — and it fires on a very broad trigger
("the prompt names Claude/Anthropic in any form"), which in a repo that exists to drive Claude Code
means it fires constantly. The audit below needed exactly two facts out of it: the price table row
and the cache multipliers. Both are copied here. Load the skill when you are *writing Claude API
code* — model ids, SDK shapes, migrations, tool schemas — and not to look up a number.

### The two facts

Claude Opus 5.5 (the pin since 2026-09-23), verified against the docs that day:
**$4 / 1M input, $20 / 1M output** — *cheaper* than the Opus 5 it replaced ($5 / $25).

| | multiple of base input | per 1M |
|---|---|---|
| cache **read** | 0.05× | $0.20 |
| cache **write**, 5-min TTL | 1.25× | $5.00 |
| cache **write**, 1-hour TTL | 2× | $8.00 |

Note the cache-read multiple: Opus 5.5 reads cache at **5%** of base input, not the usual 10%, so a
warm prefix is now a *fortieth* of a fresh read rather than a tenth. (Fable 5.1 is 2.5%.)

**A cache write costs 25–40× a cache read, per token.** That single ratio explains everything
below: the expensive event is not a long conversation, it is anything that *invalidates the prefix*
and forces it to be written again.

Prices move. Re-check them against the skill (or `platform.claude.com/docs/en/pricing`) before
quoting a dollar figure to anyone; the *ratio* is the durable part.

### What the box actually spends

Measured 2026-08-06 across all 445 transcripts in `~/.claude/projects`, 50,694 assistant turns:

```
cache_read        14,828,772,427     96.7% hit ratio
cache_creation       501,058,420
input (uncached)       1,861,947     0.01% of all input
output                55,752,073
```

Priced at the table above, that is roughly **reads $7.4k · writes $3.1–5.0k · output $1.4k**. So
**cache writes are 3.4% of the tokens and a quarter to a third of the spend.** Read:write per session
runs 25–30:1 with a median of ~5.5k written per turn — healthy. Nothing is thrashing *inside* a
session. The waste is at the session boundary.

> 🐛 **~~Auto-compaction is inert here, and tuning it saves nothing.~~ — no longer true, see the
> 2026-10-06 audit below.** In August a scan of all 445 transcripts found **7 compactions, ever**:
> sessions ended long before 60% of the window. By October they don't — the same scan over one month
> found 130, with the longest sessions parked at ~590k for thousands of calls. A finding about usage
> has a shelf life; re-measure before quoting this section.

### The actual lever: cold resumes, driven by deploys

Three things invalidate a session's cached prefix. Only one of them matters:

| | frequency | cost |
|---|---|---|
| Compaction | 7 events ever | negligible |
| `IDLE_REAP_MS` (30 min, §3) | routine | one re-write per lapsed session |
| **A deploy** | **71 logged, 49 in one week** | **one re-write per live session, box-wide** |

Every chat session is a child of `next-server`, so a deploy ends all of them (§9). The next message
in each is a cold `--resume`: the whole conversation is re-sent and re-written at 1.25–2× instead of
read at 0.1×. On a 100k-token chat that is ~200k input-equivalent for one turn against ~10k warm —
**20×**.

So the biggest usage lever available is **deploy less often**, and the structural fix is the one §9
already names for a different reason: move `lib/agent/manager.ts` into a standalone daemon with the
Next routes as thin proxies. That stops deploys killing chats, stops the deploy-veto deadlock where a
pane waiting on the human starves its own deploy, *and* stops the re-write tax. One change, three
payoffs — which is the argument for actually doing it.

**Raising `IDLE_REAP_MS` was considered and left alone.** It is the other invalidator, but at ~9
deploys a day a session idle long enough for the reaper is usually killed by a deploy first, so the
saving is speculative while the cost — idle `claude` subprocesses holding hundreds of MB each — is
not. Revisit if the daemon split lands and deploys stop ending sessions.

### 2026-10-06 audit — the window, not the prefix

300 most recent transcripts (2026-09-08 → 10-06), main threads plus 740 subagent files:

```
main thread   reads 18.7B ($3.7k) · writes 0.31B ($1.6–2.5k) · output 64M ($1.3k)
subagents     ~9B tokens, ~6.4B of them on Opus (no CLAUDE_CODE_SUBAGENT_MODEL outside Blacksmith)
first call    median 28k context (p90 48k) — the startup prefix
per call      85% of read tokens are in calls already carrying 200k–600k
```

So the startup prefix (~30k: base prompt, ~6k of skill descriptions, CLAUDE.md, hooks, the
dashboard's appends) is ~10% of an average call. What costs is the conversation re-read every call.
By content mass: Bash output 24%, inline Bash scripts 16%, images ~20% (Read of PNGs 15%, browser
screenshots 4%), thinking 9%.

Levers, ranked:

1. **Compact earlier** (`MINAMI_DASHBOARD_AUTOCOMPACT_PCT` / `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`,
   today 60%). 44% of read tokens sit in calls at 400–600k. Estimated $1–1.5k/month at 25–30%.
   *Not applied* — Thomas's call, pending.
2. **Subagent default model** (`CLAUDE_CODE_SUBAGENT_MODEL=sonnet` in global settings `env`; the
   per-call `model` param and agent frontmatter still win). *Not applied* — pending.
3. **Tool-output hygiene** — applied as a short rule block in `~/.claude/CLAUDE.md` (cap output,
   scripts in files, css-scale viewport screenshots, visual sweeps in a subagent).
4. **Deploy cold-resumes** — unchanged from above; the daemon split is still the fix.
5. **Skills** — applied via `skillOverrides` in `~/.claude/settings.json` (backup
   `settings.json.bak-2026-10-06`): `editorial-glass` off, eight skills unused for 30+ days set to
   `name-only` (still invocable by name, description gone). Worth ~$40/month; the point is a shorter,
   less noisy listing. Verified with a `claude -p` probe; the SDK's CLI is the same build (2.1.280).

> 🐛 **Don't move a skill into `~/ecvision/.claude/skills` to make it project-only.** Measured: a
> session whose cwd is a nested git repo (every `.minami-worktrees/chat-N`) does NOT see the parent's
> `.claude/skills`. Project-only means committed into the repo, or `skillOverrides` per project.

Considered and rejected: a lower default effort / `MAX_THINKING_TOKENS` (thinking is 9% and the
loss is quality everywhere); `excludeDynamicSections` (only helps cache sharing across machines).
Sources: code.claude.com/docs — skills, memory, hooks, model-config, agent-sdk/tool-search,
agent-sdk/modifying-system-prompts; anthropic.com/engineering/effective-context-engineering-for-ai-agents.

### Not measured

Whether the Haiku enrichment and flow-narration paths (234 of 445 sessions ran Haiku) are worth their
cost. They are cheap enough that they did not show up against the numbers above.

---
