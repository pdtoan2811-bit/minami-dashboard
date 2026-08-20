// WHAT A MEETING LEAVES BEHIND.
//
// The canvas is deliberately in-memory and dies with the call — that is correct for a live surface and
// useless as a record. Until this existed, a meeting produced a beautiful board and nothing you could
// read the next morning.
//
// ── The shape is chosen for MIGRATION, not for us ───────────────────────────────────────────────
// One folder per meeting, three files:
//
//   notes.md        the human artifact: decisions, actions, open questions, risks
//   canvas.json     the board as data — nodes, edges, kinds, states
//   transcript.md   what was actually said, speaker-attributed
//
// Markdown because it imports into Notion, Obsidian and every other knowledge base without a
// converter, and stays readable in a terminal if none of them work out. JSON alongside it because the
// board is a graph, and flattening a graph to prose is lossy in exactly the way that makes it
// impossible to re-render or re-import later — the models were paid for once, and the structure
// should not have to be bought again.
//
// The destination is undecided (Notion or otherwise), so this writes to disk in a form that survives
// that decision rather than guessing at an API.

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const ROOT = process.env.CANVAS_ARCHIVE_DIR || `${process.env.HOME}/.minami/meetings`;

/** Filesystem-safe slug. Vietnamese titles are the normal case here, so this deliberately keeps
 *  unicode letters rather than stripping to ASCII — "Gửi tin tức" should not become "g-i-tin-t-c". */
function slug(s, max = 60) {
  return (s || "meeting")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]+/g, " ")   // characters no filesystem tolerates
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "meeting";
}

const KIND_ORDER = ["decision", "action", "question", "risk", "milestone", "requirement", "quote", "note", "aside"];
const HEADING = {
  decision: "Decisions", action: "Actions", question: "Open questions", risk: "Risks",
  milestone: "Milestones", requirement: "Requirements", quote: "Moments", note: "Notes", aside: "Asides",
};

function notesMarkdown({ title, startedAt, minutes, speakers, graph, models }) {
  const cards = (graph.nodes ?? []).filter((n) => n.kind !== "topic");
  const topicOf = new Map((graph.nodes ?? []).filter((n) => n.kind === "topic").map((t) => [t.id, t.label]));

  const lines = [
    `# ${title}`,
    "",
    `- **When:** ${new Date(startedAt).toISOString().replace("T", " ").slice(0, 16)} · ${minutes} min`,
    speakers.length ? `- **Present:** ${speakers.join(", ")}` : null,
    /** ⚠️ NAME THE MODELS IN THE NOTE, not only in the JSON. The question this answers arrives weeks
     *  later — "why is this board so much worse than that one?" — and by then nobody remembers which
     *  ear was in use that week. The ear has moved between whisper, qwen, Blaze and an omni model,
     *  and each move changed the output visibly. A record that cannot be attributed to what produced
     *  it cannot be compared with anything. */
    models
      ? `- **Captured by:** Minami · heard by ${(models.ears ?? []).join(" + ") || "?"} · judged by ${models.judge ?? "?"}` +
        `${models.language && models.language !== "auto" ? ` · language ${models.language}` : ""}${models.room ? " · room mode" : ""}`
      : `- **Captured by:** Minami`,
    "",
  ].filter(Boolean);

  // Grouped by KIND, not by topic. A reader the next morning wants "what did we decide" and "what am
  // I supposed to do" — the topic clustering is the live board's job, not the record's.
  for (const kind of KIND_ORDER) {
    const of = cards.filter((c) => c.kind === kind);
    if (!of.length) continue;
    lines.push(`## ${HEADING[kind] ?? kind}`, "");
    for (const c of of) {
      const topic = topicOf.get(c.parent);
      const state = c.state && c.state !== "proposed" ? ` _(${c.state})_` : "";
      lines.push(`- **${c.label}**${state}`);
      if (c.detail) lines.push(`  ${c.detail}`);
      if (topic) lines.push(`  — ${topic}`);
    }
    lines.push("");
  }

  if (!cards.length) lines.push("_Nothing was captured._", "");
  return lines.join("\n");
}

/**
 * Write one meeting to disk. Returns the folder path, or null if writing failed — a failed archive
 * must never throw into the end-of-meeting path and lose the rest of the shutdown.
 */
export function archiveMeeting({ title, startedAt, minutes, graph, transcript = [], cost = 0, meetingId, models = null }) {
  try {
    /** ── THE NAME ────────────────────────────────────────────────────────────────────────────
     *  Was `YYYY-MM-DD-<title>`, and both halves were wrong.
     *
     *  The DATE alone collides: two meetings in one day wrote to the same folder and the second
     *  silently overwrote the first. The minute is what makes a folder unique in practice.
     *
     *  The TITLE is almost always the literal word "Meeting", because nothing upstream ever sets one
     *  — every archive so far is called "…-Meeting", which makes the directory listing useless
     *  exactly when anh is scanning it for the call he half-remembers. The board already knows what
     *  was discussed, so the biggest topic is a far better name than a placeholder. */
    const d = new Date(startedAt || Date.now());
    const stamp = `${d.toISOString().slice(0, 10)}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;

    const topics = (graph?.nodes ?? []).filter((n) => n.kind === "topic" && n.id !== "root");
    const counts = new Map();
    for (const n of graph?.nodes ?? []) if (n.parent) counts.set(n.parent, (counts.get(n.parent) ?? 0) + 1);
    const biggest = topics.sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))[0];
    const generic = !title || /^meeting$/i.test(title.trim());
    const name = generic && biggest ? biggest.label : title || "Meeting";

    const dir = join(ROOT, `${stamp}-${slug(name)}`);
    mkdirSync(dir, { recursive: true });

    const speakers = [...new Set(transcript.map((l) => l.split(":")[0]).filter((s) => s && s.length < 40))];

    /** ⚠️ THE NOTE GETS THE DERIVED NAME TOO, not the raw title.
     *
     *  `name` already falls back to the biggest topic when the title is the generic word "Meeting" —
     *  that is why the FOLDER is called 2026-08-20_1158-Second-Brain. But the note was handed the raw
     *  `title`, so the same meeting opened with "# Meeting" while its own directory knew better. The
     *  file you actually read was the one place the good name did not reach. */
    writeFileSync(join(dir, "notes.md"), notesMarkdown({ title: name, startedAt, minutes, speakers, graph, models }));
    writeFileSync(
      join(dir, "canvas.json"),
      JSON.stringify({ meetingId, title, startedAt, minutes, cost, models, graph }, null, 2),
    );
    writeFileSync(
      join(dir, "transcript.md"),
      [`# ${name} — transcript`, "", ...transcript.map((l) => `- ${l}`), ""].join("\n"),
    );

    /** ── THE INDEX ───────────────────────────────────────────────────────────────────────────
     *  One appended line per meeting. Without it, finding a call means opening folders one at a time
     *  to see what is inside them — the archive grows into exactly the junk pile anh wants to avoid,
     *  not because there are too many meetings but because none of them announce what they are.
     *
     *  Appended rather than rebuilt, so a corrupted or hand-edited index costs one line, not history. */
    const cards = (graph?.nodes ?? []).filter((n) => n.kind !== "topic").length;
    const row = `| ${stamp.replace("_", " ")} | [${name}](${basename(dir)}/notes.md) | ${minutes} min | ${cards} cards | $${Number(cost).toFixed(4)} |`;
    const index = join(ROOT, "index.md");
    if (!existsSync(index)) {
      writeFileSync(index, ["# Meetings", "", "| when | what | length | cards | cost |", "|---|---|---|---|---|", ""].join("\n"));
    }
    appendFileSync(index, row + "\n");

    return dir;
  } catch (e) {
    console.error("[archive] failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
