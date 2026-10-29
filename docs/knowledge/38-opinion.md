# §38 · Opinion Reveal — pick any story, rant, and it becomes the weekly video

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

A page at **`/opinion`** (rail: Library → Opinion Reveal) where Thomas gives his own takes on recent AI news for Video
Studio's weekly **Opinion Reveal** video, read by each channel's narrator (VI and EN from the same takes). Thomas,
2026-10-29: "a weekly video that I put my own thoughts into, based on the actual news that week". The chat is the pick
from the pitch bench (`~/ecvision/pitches/opinion-interview`, round 2 **V2 "Rant to a friend"**: "close to friend
ranting via chat, let me send multiple messages for a question and a finish button to wrap the answer").

**It is never closed.** The first version was one weekly interview, drafted Friday and locked Saturday, and the page
said "No interview yet" the rest of the week. Thomas, the same day: "should not block my access like this, but I can
randomly visit and pick topic to read/express opinion on". So every recent daily story is a topic, open any time, and
the weekly lock only gathers what he has already said.

## Who writes what (`<studio>/harness/opinion/`)

| file | writer | what |
|---|---|---|
| `topics.json` | `scripts/opinion.mjs topics` (Video Studio, daily 09:00 + Fri 14:00) | every daily EN episode of the last 14 days, one topic per distinct story (Sonnet dedupes): tag, headline, fact (only from the episode's lines), a friend-style `news` line, 2 questions, a `guess` |
| `takes/<id>.json` | **this page only** (`lib/opinion.ts`) | his messages, `asked2`, the take, confirmed / lead / skipped |
| `<week>/interview.json` | `opinion.mjs lock` (Sat 12:05) | the confirmed takes not yet in a video (lead first, ≤ 5) → `locked` (≥ 3) or `no-video`; the overnight run builds `locked` the night after |

One file per take means the page never races the studio's writers. The lock writes `usedIn` on the takes it used, and
only on `locked`: below 3 takes they wait for next week while their story is fresh (10 days). Launchd job:
`com.thomas.video-opinion` (Automations).

## The page

- **Topics** (default): a strip saying how many takes are waiting against the 3 that make a video, and when it locks;
  All / Not answered / Yours; stories grouped by day, newest first, with their status (✓ your take, ★ lead, started,
  skipped, in W44). Stories older than 10 days say they are too old for this week's video.
- **The chat** (`?t=<id>`, so the phone's back gesture returns to the list): Minami's side is **scripted, not a model**
  — an opener, the `news` line, the story card, Q1. After his first message, once he is quiet for 6 s (`QUIET_MS`),
  Minami "types" and asks Q2 with a short nudge. A model replying with opinions would leak into what he says; the
  friend feel comes from the rhythm (short bubbles, a typing beat, one reaction per story).
- **Done ranting ✓** wraps his messages: `joinTake` trims each, adds a full stop where a line had no end mark, joins
  them. Nothing reworded or added (Video Studio's Never #4). Then Sounds like me / Edit / Keep ranting / ★ Lead (one
  lead among the waiting takes; its line is the hook) / Next topic. **stuck?** sends the `guess` as his message,
  tagged "· my guess"; **skip this one** skips the story.

> 🐛 **Confirming jumped away from the story (2026-10-29, v1).** The view defaulted to the first unanswered story, so
> confirming one moved on before "got it ✓" and the ★ could be seen. In v2 the open story is the URL's, so it stays.
>
> 🐛 **A bubble corner stayed square.** `borderRadius` plus one `borderBottomRightRadius` loses the corner when the
> tail moves to the next bubble (React removes the lone property beside the shorthand). One shorthand string per state.
>
> 🐛 **On a phone the composer sat under the tab bar.** The chat's height subtracts `--shell-top` and `--shell-bottom`.
