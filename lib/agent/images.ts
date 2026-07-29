// Turning image paths mentioned in a message into inline image blocks for the model.
//
// WHY PATHS AND NOT AN UPLOAD PAYLOAD
// The composer's contract (Composer.tsx) is that the textarea is the single source of truth for what
// Claude receives. The existing attach button already honours that by inserting a bare *path* rather
// than carrying bytes ("Attach a file (inserts its path for Claude to read)"). Pasting keeps the same
// shape: the bytes land on disk, the path goes in the text, and this module is what turns that path
// into something the model can actually see.
//
// Everything follows from that one decision:
//   • no base64 crosses the wire from the browser — the server reads the file it already wrote;
//   • an image attached via the folder picker is inlined too, for free, with no separate code path;
//   • the message stored in the transcript is plain text containing a path, so `claude-sessions.ts`
//     (which extracts ONLY text blocks from user messages — see its line ~401) preserves it. An image
//     block in a user turn would be silently dropped on reload; a path survives, and the panel can
//     re-render the thumbnail from it.
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Absolute paths ending in an image extension — bare, or double-quoted.
 *
 * Bare is the format the attach button has always inserted, so paste needs no new syntax. The quoted
 * alternative exists because a bare path cannot express a space, and the single most common image a
 * person attaches on a Mac is `~/Desktop/Screen Shot 2026-01-01 at 10.00.00.png`. Without this the
 * feature would look broken on exactly the file it will most often be pointed at, and would fail
 * silently — no thumbnail, no inline image, no error.
 */
const IMAGE_PATH = /(?:^|[\s(])"(\/[^"]+\.(?:png|jpe?g|gif|webp))"|(?:^|[\s(])(\/[^\s"'()]+\.(?:png|jpe?g|gif|webp))(?=[\s)]|$)/gi;

export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};

// The Anthropic API downsizes anything over 1568px itself, so this cap is about not shipping tens of
// megabytes through a local request — not about token cost.
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 5;

export type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};

/** Every distinct image path referenced in `text`, in order, capped. */
export function imagePathsIn(text: string): string[] {
  const out: string[] = [];
  // Group 1 is the quoted form, group 2 the bare one — exactly one is set per match.
  for (const m of text.matchAll(IMAGE_PATH)) {
    const p = m[1] || m[2];
    if (p && !out.includes(p)) out.push(p);
  }
  return out.slice(0, MAX_IMAGES);
}

/**
 * Read the images `text` refers to and return them as API content blocks.
 *
 * Never throws and never rejects the send: a path that is missing, too big, or not really an image
 * simply doesn't become a block. The path stays in the message either way, so the worst case degrades
 * to exactly the old behaviour — Claude sees a path and can Read it itself.
 */
export async function imageBlocksFor(text: string): Promise<ImageBlock[]> {
  const blocks: ImageBlock[] = [];
  for (const p of imagePathsIn(text)) {
    const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
    if (!mime) continue;
    try {
      const st = await fs.stat(p);
      if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) continue;
      const buf = await fs.readFile(p);
      if (!looksLikeImage(buf)) continue;
      blocks.push({ type: "image", source: { type: "base64", media_type: mime, data: buf.toString("base64") } });
    } catch { /* unreadable — leave the path as text and move on */ }
  }
  return blocks;
}

/** Magic-byte check. An extension is a claim; the header is the fact — and this is what stops a
 *  renamed non-image from being shipped to the API as one. */
export function looksLikeImage(b: Buffer): boolean {
  if (b.length < 12) return false;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;            // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;                              // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true;             // GIF8
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return true; // WebP
  return false;
}
