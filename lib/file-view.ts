// Folds a transcript into "which files did this session touch, and what happened to them" — the data
// behind the file preview panel and the inline created/changed chips in the chat.
//
// Same shape of thing as lib/browser-view.ts and lib/flow-model.ts: a pure derivation over the turns
// the pane already holds, not a second event pipeline. Nothing here fetches; the panel fetches content
// on demand from /api/fs/file, because a transcript records that a file was written, not what is in it
// NOW — and "what is in it now" is the only thing worth previewing.
import { type ToolOutput } from "./agent/labels";

/** What happened to a file. Ordered by how much a reviewer cares: a write outranks a read, so a file
 *  that was read and then edited is listed as edited. */
export type FileVerb = "created" | "changed" | "read";

export type TouchedFile = {
  path: string;
  name: string;
  verb: FileVerb;
  /** Index of the turn it was last touched in — lets the panel order by recency without a clock. */
  turn: number;
  /** The tool_use id of the last call that touched it, so a transcript chip can point at this entry. */
  toolId?: string;
};

export type FileState = {
  files: TouchedFile[];
  /** Latched: once anything has been touched, the panel stays available for the session even if the
   *  visible transcript window later scrolls past those turns. Mirrors BrowserState.everUsed. */
  everUsed: boolean;
};

const EMPTY: FileState = { files: [], everUsed: false };

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "NotebookRead"]);

type FileToolCall = { name: string; input?: unknown; id?: string; output?: ToolOutput };
type FileTurnLike = { tools: FileToolCall[] };

const textOf = (o?: ToolOutput): string =>
  o?.blocks?.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n") ?? "";

/** The path a call acted on. Read/Write/Edit all use `file_path`; NotebookEdit uses `notebook_path`. */
function pathOf(t: FileToolCall): string | null {
  const i = t.input as { file_path?: unknown; notebook_path?: unknown } | undefined;
  const v = i?.file_path ?? i?.notebook_path;
  return typeof v === "string" && v.startsWith("/") ? v : null;
}

/** created vs changed, from the RESULT rather than the tool name.
 *
 *  `Write` does both jobs — it creates a file or silently overwrites an existing one — so keying off
 *  the tool name would label every overwrite "created" and quietly lie about what happened to a file
 *  that already had contents. The CLI's own result text distinguishes them exactly:
 *      "File created successfully at: <path>"
 *      "The file <path> has been updated successfully."
 *  Falls back to the tool name only when there's no result yet (the call is still in flight). */
function verbOf(t: FileToolCall): FileVerb {
  if (READ_TOOLS.has(t.name)) return "read";
  const out = textOf(t.output);
  if (/\bcreated successfully\b/i.test(out)) return "created";
  if (/\bhas been updated\b|\bApplied \d+ edit/i.test(out)) return "changed";
  return t.name === "Write" ? "created" : "changed";
}

// A later touch wins, but never downgrades: reading a file after editing it doesn't make it a read.
const RANK: Record<FileVerb, number> = { read: 0, changed: 1, created: 2 };

/** Fold turns into the touched-file list, most recently touched first. */
export function deriveFileState(turns: FileTurnLike[]): FileState {
  if (!turns?.length) return EMPTY;
  const byPath = new Map<string, TouchedFile>();

  turns.forEach((turn, ti) => {
    for (const t of turn.tools || []) {
      const isWrite = WRITE_TOOLS.has(t.name);
      if (!isWrite && !READ_TOOLS.has(t.name)) continue;
      const p = pathOf(t);
      if (!p) continue;
      const verb = verbOf(t);
      const prev = byPath.get(p);
      byPath.set(p, {
        path: p,
        name: p.split("/").pop() || p,
        // Keep the strongest verb ever seen for this file, not the latest one — "Claude created this"
        // stays true after it later re-reads the file to check its own work.
        verb: prev && RANK[prev.verb] > RANK[verb] ? prev.verb : verb,
        turn: ti,
        toolId: t.id ?? prev?.toolId,
      });
    }
  });

  if (!byPath.size) return EMPTY;
  // Most recent first: the file you want is almost always the one just touched. Ties broken by write-
  // over-read so a freshly edited file outranks a file merely read in the same turn.
  const files = [...byPath.values()].sort((a, b) => b.turn - a.turn || RANK[b.verb] - RANK[a.verb]);
  return { files, everUsed: true };
}

/** The files a SINGLE tool call wrote — what the inline chip under a message renders from. Reads are
 *  excluded on purpose: a chip for every file Claude looked at would bury the two it changed. */
export function writtenBy(t: FileToolCall): { path: string; name: string; verb: FileVerb } | null {
  if (!WRITE_TOOLS.has(t.name)) return null;
  const p = pathOf(t);
  if (!p) return null;
  return { path: p, name: p.split("/").pop() || p, verb: verbOf(t) };
}
