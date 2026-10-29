# §38 · Opinion Reveal — the weekly interview, answered as a chat

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

A page at **`/opinion`** (rail: Library → Opinion Reveal) where Thomas answers the weekly interview behind
Video Studio's **Opinion Reveal** video: his own takes on the week's AI news, read by each channel's narrator
(VI and EN from one interview). Thomas, 2026-10-29: "a weekly video that I put my own thoughts into, based on the
actual news that week". Picked on the pitch bench (`~/ecvision/pitches/opinion-interview`, round 2 **V2 "Rant to a
friend"**). His note on round 1: "close to friend ranting via chat, let me send multiple messages for a question and
a finish button to wrap the answer".

## The week

| when | who | what |
|---|---|---|
| Fri 14:00 | launchd `com.thomas.video-opinion` → `node scripts/opinion.mjs auto` (Video Studio) | Sonnet reads the week's daily EN episodes, picks 5 distinct stories, writes per story: tag, headline, fact (only from the episode's lines), a friend-style `news` line, 2 questions, a `guess`. → `<studio>/harness/opinion/<week>/interview.json`, a line in `harness/yours.jsonl` |
| Fri–Sat | Thomas, `/opinion` | the chat: every message is written to the file as he sends it |
| Sat 12:05 | the same job | `lock`: 3+ confirmed takes → `locked`, else `no-video`; the yours line is cleared |
| Sat night | the overnight run | builds the VI and EN video from the takes (`formats/opinion`) |

The studio owns the file. This page only appends messages and sets take / confirmed / lead / skipped while the
status is `open` (`lib/opinion.ts`), and every write is tmp + rename, because the lock can read it at any moment.
`VIDEO_STUDIO_DIR` points it at another checkout (a worktree, for testing).

## The chat

- Minami's side is **scripted, not a model**: an opener, the `news` line, the story card, Q1. After his first
  message to Q1, once he goes quiet for 6 s (`QUIET_MS`), Minami "types" for a beat and asks Q2 with a short nudge
  ("haha go on."). A model replying with opinions would leak into what he says, and the friend feel comes from the
  rhythm (short bubbles, the typing beat, one reaction per story), not from generated chatter.
- **Done ranting ✓** wraps his messages into the take: `joinTake` trims each, adds a full stop where a line had no
  end mark, and joins them. Nothing is reworded or added. This is Video Studio's Never #4 (no invented quote).
  "Sounds like me" confirms it. He can Edit it, "Keep ranting" (reopen), or ★ lead (one per week: its line is the
  hook).
- **stuck?** sends the drafted `guess` as his message, tagged `guess: true` and shown "· my guess". **skip this one**
  skips the story.
- The progress dots jump to any story. After the last one, a summary lists every take, and any of them can be
  changed until the close.

> 🐛 **Confirming jumped away from the story (2026-10-29).** The view defaults to the first unsettled story, so
> confirming one moved the view to the next, and "got it ✓" and the ★ were never seen. "Sounds like me" pins the
> story (`setAt(idx)`), and Next story releases it.
>
> 🐛 **A bubble corner stayed square.** A style with `borderRadius` plus one `borderBottomRightRadius` loses the corner
> when the tail moves to the next bubble (React removes the lone property beside the shorthand). It is now one
> shorthand string per state.
>
> 🐛 **On a phone the composer sat under the tab bar.** The chat's height subtracts `--shell-top` and `--shell-bottom`,
> as `/architecture` does.
