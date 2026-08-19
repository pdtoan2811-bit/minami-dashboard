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

Claude Opus 5, as of 2026-08-06: **$5 / 1M input, $25 / 1M output.**

| | multiple of base input | per 1M |
|---|---|---|
| cache **read** | 0.1× | $0.50 |
| cache **write**, 5-min TTL | 1.25× | $6.25 |
| cache **write**, 1-hour TTL | 2× | $10.00 |

**A cache write costs 12.5–20× a cache read, per token.** That single ratio explains everything
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

> 🐛 **Auto-compaction is inert here, and tuning it saves nothing.** `AUTOCOMPACT_PCT` defaults to 60
> (`lib/agent/manager.ts`), which looks aggressive — compacting with 40% of the window still free,
> paying a full-window summarisation and throwing away the prompt cache each time. A raw scan for
> every compaction marker across all 445 transcripts found **7 events, ever** — 6 automatic, 1 manual.
> Sessions on this box end long before they reach 60% of the window. The hypothesis was reasonable and
> the data killed it; recorded so nobody re-derives it and starts tuning the knob.

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

### Not measured

Whether the Haiku enrichment and flow-narration paths (234 of 445 sessions ran Haiku) are worth their
cost. They are cheap enough that they did not show up against the numbers above.

---
