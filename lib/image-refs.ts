// Absolute paths to image files, mentioned anywhere in a message. Must stay in step with
// IMAGE_PATH in lib/agent/images.ts, which is what decides which of these actually get sent to the
// model — a path that renders as a thumbnail but isn't inlined there (or vice versa) is a lie either way.
// Shared by the transcript's thumbnails (app/page.tsx) and the New task sheet's attachment strip.
export const IMAGE_REF = /(?:^|[\s(])"(\/[^"]+\.(?:png|jpe?g|gif|webp))"|(?:^|[\s(])(\/[^\s"'()]+\.(?:png|jpe?g|gif|webp))(?=[\s)]|$)/gi;

/** Every distinct image path in the text, in order. Group 1 is the quoted form, group 2 the bare one. */
export function imageRefs(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  for (const m of text.matchAll(IMAGE_REF)) { const p = m[1] || m[2]; if (p && !out.includes(p)) out.push(p); }
  return out;
}

/** The text with one image path taken out, quoted or bare, plus the space the composer put after it. */
export function dropImageRef(text: string, p: string): string {
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`"${esc}" ?|${esc} ?`), "").replace(/[ \t]+\n/g, "\n");
}

export const imageUrl = (p: string) => `/api/fs/image?path=${encodeURIComponent(p)}`;
