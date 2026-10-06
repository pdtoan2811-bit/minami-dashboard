// The reader half of the ending contract (PREVIEW_PROMPT in lib/agent/manager.ts): every dashboard
// session is asked to end viewable work with a fenced ```minami-preview block holding a JSON array
// of {kind, target, label}, and to drop a ```minami-preview-ready block (same JSON) mid-message the
// moment something is viewable before the work is done. This module splits both back OUT of the
// message so the shell can render chips where the fences were — one parser, used for live streamed turns and turns rebuilt
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
/** The mid-turn twin (§5c): "this is viewable NOW, I'm still working". Same JSON, any position, any
 *  number of times. Note it shares FENCE as a prefix — every FENCE search below must skip it. */
const READY = "```minami-preview-ready";

/** One piece of a rendered message, in order: prose, or a row of "ready" chips where a mid-message
 *  ```minami-preview-ready block sat. */
export type Segment = { kind: "text"; text: string } | { kind: "ready"; previews: Preview[] };

/** The JSON body of a block → previews, or null when it isn't a usable array. Shared by both fences
 *  so a ready-row and the tail row can never disagree about what a valid entry is. */
function parsePreviews(raw: string): Preview[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.trim()); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  return parsed
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
}

/** Last index of the TAIL fence proper — "```minami-preview" not followed by "-" (which would make it
 *  the ready fence). Without the skip, a reply that ended on a ready-block read as a broken tail block
 *  and lost its chips, and one with prose after a ready-block was left as raw JSON. */
function lastTailFence(text: string): number {
  let at = text.lastIndexOf(FENCE);
  while (at !== -1 && text.charCodeAt(at + FENCE.length) === 45 /* "-" */) at = at === 0 ? -1 : text.lastIndexOf(FENCE, at - 1);
  return at;
}

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
 *  Ready-blocks are NOT handled here (they stay in `body`) — splitPreviewSegments does both.
 */
export function splitPreviewBlock(text: string): { body: string; previews: Preview[] } {
  const at = lastTailFence(text);
  if (at === -1) return { body: text, previews: [] };
  // Only honour a block that is actually the tail of the message (contract: LAST thing). Anything
  // after the closing fence but whitespace means the model was *talking about* the format — e.g.
  // this file's own docs pasted into a chat — and stripping it would eat real content.
  const rest = text.slice(at + FENCE.length);
  const close = rest.indexOf("```");
  if (close !== -1 && rest.slice(close + 3).trim() !== "") return { body: text, previews: [] };
  const body = text.slice(0, at).trimEnd();
  if (close === -1) return { body, previews: [] }; // still streaming in — hide, don't flash
  return { body, previews: parsePreviews(rest.slice(0, close)) ?? [] };
}

/** Where the next ready fence OPENS, from `from`: it must start a line (indentation allowed — a
 *  list item's fence is still a fence), so a sentence that merely mentions it inline stays prose.
 *  Returns -1 when there is none. */
function nextReadyFence(text: string, from: number): number {
  for (let at = text.indexOf(READY, from); at !== -1; at = text.indexOf(READY, at + 1)) {
    let i = at - 1;
    while (i >= 0 && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i--;
    if (i < 0 || text.charCodeAt(i) === 10 /* "\n" */) return at;
  }
  return -1;
}

/** Every ready-block in `text`, in order. `raw` is the block's JSON body (for dedupe keys); `previews`
 *  is null when the block is still open (`closed: false`, only ever the last) or its JSON is unusable. */
function readyBlocks(text: string): { start: number; end: number; closed: boolean; raw: string; previews: Preview[] | null }[] {
  const out: { start: number; end: number; closed: boolean; raw: string; previews: Preview[] | null }[] = [];
  let at = nextReadyFence(text, 0);
  while (at !== -1) {
    const open = at + READY.length;
    // The info string ends at the newline. Anything else glued on ("```minami-preview-readyX") is
    // not our fence; skip it as prose.
    const nl = text.indexOf("\n", open);
    const info = text.slice(open, nl === -1 ? text.length : nl);
    if (info.trim() !== "") { at = nextReadyFence(text, open); continue; }
    const close = nl === -1 ? -1 : text.indexOf("```", nl);
    if (close === -1) { out.push({ start: at, end: text.length, closed: false, raw: "", previews: null }); break; }
    const raw = text.slice(nl + 1, close);
    out.push({ start: at, end: close + 3, closed: true, raw: raw.trim(), previews: parsePreviews(raw) });
    at = nextReadyFence(text, close + 3);
  }
  return out;
}

/** The whole message as ordered segments: prose and ready-rows, plus the tail block's previews.
 *
 *  Runs per streamed token on the live row, so the common case (no ready fence anywhere) is one
 *  indexOf on top of splitPreviewBlock. Failure modes, all degrading to "no chips":
 *  - A ready-block still open (mid-stream) hides everything from its fence on — never raw JSON.
 *    It is the newest thing in the message, so what's hidden is only what hasn't finished arriving.
 *  - Invalid JSON → that block is dropped from view and the prose either side is kept.
 *  - The tail ```minami-preview contract is untouched: old conversations render exactly as before.
 */
export function splitPreviewSegments(text: string): { segments: Segment[]; previews: Preview[] } {
  const split = splitPreviewBlock(text);
  const { previews } = split;
  let { body } = split;
  // The fence itself arrives over several tokens. "```minami-preview" alone is already hidden as an
  // open tail block, but "```minami-preview-rea" is neither fence yet — without this it flashes as an
  // empty code block for a token or two on every ready-block.
  const ln = body.lastIndexOf("\n") + 1;
  const last = body.slice(ln).trimStart();
  if (last.length > 3 && READY.startsWith(last)) body = body.slice(0, ln).trimEnd();
  if (body.indexOf(READY) === -1) return { segments: body ? [{ kind: "text", text: body }] : [], previews };
  const segments: Segment[] = [];
  const pushText = (s: string) => { if (s.trim()) segments.push({ kind: "text", text: s.replace(/^\s*\n/, "").trimEnd() }); };
  let pos = 0;
  for (const b of readyBlocks(body)) {
    pushText(body.slice(pos, b.start));
    if (b.previews?.length) segments.push({ kind: "ready", previews: b.previews });
    pos = b.end;
  }
  pushText(body.slice(pos));
  return { segments, previews };
}

/** The server half: every CLOSED, valid ready-block in a streaming message, with a stable key (its
 *  JSON body) for "have I already announced this one". Cheap no-op when the fence is absent. */
export function closedReadyBlocks(text: string): { key: string; previews: Preview[] }[] {
  if (text.indexOf(READY) === -1) return [];
  return readyBlocks(text).flatMap((b) => (b.closed && b.previews?.length ? [{ key: b.raw, previews: b.previews }] : []));
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
