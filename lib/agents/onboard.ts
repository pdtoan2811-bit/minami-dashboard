// The onboarding interview — the message that turns a scaffolded folder into an actual brain.
//
// This isn't a form. It's the opening prompt of a real dashboard session running in the agent's home
// folder, so the questions arrive as AskUserQuestion cards in the pane (components/AskCard.tsx) and
// the answers are written to disk by the agent itself, in its own voice, in its own folder. A form
// could capture the same fields and would produce a persona nobody wrote — the interview is the point.
//
// Kept as a prompt rather than a skill deliberately: skills load by cwd, and this has to run in a
// folder that doesn't have any yet.
import path from "node:path";
import { ACTIVITY_FILE, MEMORY_FILE, NOTE_DIRS } from "./scaffold";
import type { AgentDef } from "./types";

export function onboardingPrompt(a: AgentDef, opts: { adopted: boolean }): string {
  const dirs = NOTE_DIRS.map((d) => `\`${d}/\``).join(", ");
  const adopted = opts.adopted
    ? `This folder already had work in it — **read what's here before you ask me anything.** \`ls\`, read
any existing \`CLAUDE.md\`, skim the note structure. Then only ask about what you genuinely can't
infer. Asking me to re-state something already written here is the fastest way to feel like a form.`
    : `This folder is new and near-empty — everything you need has to come from this conversation.`;

  return `You are being set up as **${a.name}**, a standing agent on this machine. This folder
(\`${a.home}\`) is your home: your persona, your notes, your memory. Right now it's a scaffold with
TODOs in it. Your job this session is to interview me and turn it into something real.

${adopted}

**Interview me with the AskUserQuestion tool** — real chips, not a numbered list in prose. Go a few
questions at a time, and let my answers steer the next batch rather than working through a fixed
script. Cover, roughly:

1. **Identity** — what do I actually want you for? What kinds of request should land on you, and what
   should go to someone else? What does "done well" look like coming from you?
2. **Voice** — how should you talk to me? What should you never do (over-explain, hedge, ask before
   acting, act before asking)?
3. **Knowledge** — what do you need to know that isn't in any repo? Context, history, constraints,
   the people and systems involved, what I've already tried.
4. **Tools** — what should you be free to run, and what should you check with me first? Anything
   outward-facing (sending, publishing, deleting, spending) is worth naming explicitly.
5. **How you'll be used** — do I chat with you, assign you unattended tasks, or both? Will another
   agent hand you work?

Then **write the folder**:

- \`CLAUDE.md\` — replace every TODO. Who you are, what you own, what you never do, your voice, and
  how you maintain this folder. Write it as instructions to yourself, second person, and keep it
  tight — it costs tokens on every session you'll ever run.
- \`${MEMORY_FILE}\` — the durable facts from my answers. Group by topic. Include the *why* behind any
  decision, not just the decision.
- Notes under ${dirs} — anything that's knowledge rather than identity. Give each note a title and a
  first line that says what it's for.
- \`.claude/settings.json\` — the permission \`allow\`/\`deny\` lists we agreed on.
- \`.claude/skills/<name>/SKILL.md\` — only if a repeatable procedure came up. A skill needs a
  \`description\` saying *when* to use it, or it never loads. Don't invent one to fill the slot.

Two rules while you write:

- **Don't invent.** If something didn't come up in the interview, either ask or leave it out. A
  confident fabrication in \`CLAUDE.md\` gets treated as fact by every session after this one.
- **Quote me where it matters.** My exact words about how I want things done are worth more than your
  paraphrase.

Finish by showing me what you wrote — the file list plus your \`CLAUDE.md\` in full — and telling me
what you'd still like to know. Append a line to \`${ACTIVITY_FILE}\` noting that you were set up today.`;
}

/**
 * The brief an assigned task actually runs as.
 *
 * The wrapper matters more than it looks. An unattended run has NO ONE WATCHING: a question parks the
 * session, and a parked session holds `busy` true, which is what bin/deploy.sh waits on box-wide (see
 * the minami-flow skill's deadlock). The runner has its own guard for that, but the cheaper fix is to
 * tell the agent up front that asking isn't available, so it states an assumption and proceeds
 * instead of stalling behind a question nobody will answer.
 */
export function taskPrompt(a: AgentDef, opts: { title: string; brief: string; cwd: string; from?: string }): string {
  const away = opts.cwd !== a.home;
  const origin = opts.from
    ? `This was handed to you by **${opts.from}**, not by Thomas directly. Its brief is below verbatim —
if something in it is ambiguous, resolve it the way ${opts.from} most likely meant and say which
reading you took.`
    : `Thomas assigned this.`;

  return `**Task: ${opts.title}**

${origin}

${opts.brief}

---

**How this run works.** You're running unattended — nobody is watching this pane, so **you cannot ask
a question**. If something's ambiguous, pick the most reasonable reading, say which one you took, and
carry on. A run that stops to ask just stalls until it's killed.

${away ? `You're working in \`${opts.cwd}\`, which is not your home folder. Read that project's own
\`CLAUDE.md\` and follow its conventions — you're a guest there. The work belongs in that folder;
what you learn belongs back in \`${a.home}\`, and you'll be prompted for that at the end.`
    : `You're working in your own folder.`}

Finish by stating plainly what you did, what you changed, and anything you couldn't do. That summary
is what gets shown on your tile and what any agent downstream of you receives — so make it stand on
its own, without this brief next to it.`;
}

/**
 * The wrap-up sent after an unattended task's run finishes. This is the "self-updates every session"
 * half that a mechanical log line can't do: only the agent knows what it *learned*, and only it can
 * decide where that belongs.
 *
 * A second message rather than an instruction bolted onto the brief, because a brief that ends with
 * "and also write your memory" gets treated as one task with a tail, and the tail is what gets
 * dropped when the real work runs long. As its own turn it either happens or visibly doesn't.
 */
export function wrapUpPrompt(a: AgentDef, cwd: string): string {
  const away = cwd !== a.home;
  return `That run is finished. Before this session ends, update your memory.

${away ? `You were working in \`${cwd}\`, which is not your home. The work stays there; what you
LEARNED goes back to \`${a.home}\`. Write to the absolute paths under your home folder — don't write
memory into the workspace.` : `You were working in your own folder.`}

Append one line to \`${path.join(a.home, ACTIVITY_FILE)}\`: the date, where you worked, what the task
was, and how it ended.

Then, only if there's something durable: add it to \`${path.join(a.home, MEMORY_FILE)}\` or the
matching note under \`${path.join(a.home, "10-19 Projects")}/\`. Durable means a decision and its
reasoning, a constraint you discovered, an open loop, or something that will still be true next
month. Merge into what's already there rather than appending a new near-duplicate section.

If nothing durable came out of this run, say so and write nothing. An honest empty is better than
padding your own memory with noise you'll have to read forever.`;
}
