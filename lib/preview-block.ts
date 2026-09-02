// The reader half of the ending contract (PREVIEW_PROMPT in lib/agent/manager.ts): every dashboard
// session is asked to end viewable work with a fenced ```minami-preview block holding a JSON array
// of {kind, target, label}. This module splits that block back OUT of the message so the shell can
// render chips where the fence was — one parser, used for live streamed turns and turns rebuilt
// from disk alike, so old conversations grow chips retroactively.
//
// Pure and dependency-free on purpose: it runs inside TurnRow, which is memoised and re-renders per
// streamed token on the live row, so it must be cheap and cannot touch anything stateful.

export type Preview = {
  /** url → open in a new tab; file → the shell's file panel; cmd → copy to clipboard. */
  kind: "url" | "file" | "cmd";
  target: string;
  label: string;
};

const FENCE = "```minami-preview";

/** Split a message into prose and its trailing preview block.
 *
 *  Returns the text with the block removed and whatever previews parsed. Tolerant by design — the
 *  block is model-authored, so every failure mode degrades to "no chips" rather than an error:
 *  - No fence, or fence not near the end → text unchanged, no previews.
 *  - Fence opened but not yet closed (mid-stream) → the partial block is HIDDEN from the prose (it
 *    is the tail of the reply by contract, so nothing real is lost) and no chips render until it
 *    parses. Without this the raw JSON flashes as a code block while streaming.
 *  - JSON invalid or not an array → block hidden, no chips. Hiding beats showing here: a mangled
 *    contract block is machine noise the reader never asked to see.
 */
export function splitPreviewBlock(text: string): { body: string; previews: Preview[] } {
  const at = text.lastIndexOf(FENCE);
  if (at === -1) return { body: text, previews: [] };
  // Only honour a block that is actually the tail of the message (contract: LAST thing). Anything
  // after the closing fence but whitespace means the model was *talking about* the format — e.g.
  // this file's own docs pasted into a chat — and stripping it would eat real content.
  const rest = text.slice(at + FENCE.length);
  const close = rest.indexOf("```");
  if (close !== -1 && rest.slice(close + 3).trim() !== "") return { body: text, previews: [] };
  const body = text.slice(0, at).trimEnd();
  if (close === -1) return { body, previews: [] }; // still streaming in — hide, don't flash
  let parsed: unknown;
  try { parsed = JSON.parse(rest.slice(0, close).trim()); } catch { return { body, previews: [] }; }
  if (!Array.isArray(parsed)) return { body, previews: [] };
  const previews = parsed
    .filter((p): p is Preview =>
      !!p && typeof p === "object" &&
      (p.kind === "url" || p.kind === "file" || p.kind === "cmd") &&
      typeof p.target === "string" && p.target.length > 0)
    .slice(0, 4)
    .map((p) => ({ kind: p.kind, target: p.target, label: typeof p.label === "string" && p.label ? p.label : p.target }))
    // Localhost first regardless of authored order — it's the #1 preview by decree (a running app
    // beats a file diff), and the prompt asking for that ordering is a request, not a guarantee.
    // Array.prototype.sort is stable, so everything else keeps its authored order.
    .sort((a, b) => Number(isLocalUrl(b)) - Number(isLocalUrl(a)));
  return { body, previews };
}

/** The chip row's primary case: a url on this machine. Hostname check, not substring — a remote
 *  url with "localhost" in its path must not get the crown. */
export function isLocalUrl(p: Preview): boolean {
  if (p.kind !== "url") return false;
  try {
    const h = new URL(p.target).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "0.0.0.0";
  } catch { return false; }
}
