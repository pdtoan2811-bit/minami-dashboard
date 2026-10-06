// The SLIM transcript (§1): the same turns, with every image's base64 swapped for a URL.
//
// Measured 2026-10-06 (docs/knowledge/bench/): screenshots were 4.0 MB of a 4.7 MB transcript response —
// 18 images — while the conversation itself was ~120 KB, and every open pane re-downloaded all of it
// every 2.5s. An image is only ever needed when it is drawn (a thumbnail in an expanded tool row, the
// browser panel, the lightbox), so it now travels by URL and the browser fetches it then, once, cached
// forever: a tool result never changes after it is written. Text outputs (capped at 4,000 chars at
// parse time) and inputs stay inline — together ~10% of the payload, and the file panel and flow view
// read them directly.
import type { Turn } from "@/lib/claude-sessions";

export function slimTurns(turns: Turn[], sid: string, before?: number): Turn[] {
  const q = before ? `&before=${before}` : "";
  return turns.map((t) => {
    if (!t.tools?.some((tc) => tc.output?.blocks?.some((b) => b.type === "image" && b.data))) return t;
    return {
      ...t,
      tools: t.tools.map((tc) => {
        // No id, no way to ask for it again — keep the bytes inline rather than lose the picture.
        if (!tc.id || !tc.output?.blocks?.some((b) => b.type === "image" && b.data)) return tc;
        let k = -1;
        return {
          ...tc,
          output: {
            ...tc.output,
            blocks: tc.output.blocks.map((b) => {
              if (b.type !== "image") return b;
              k++;
              return { type: "image" as const, mediaType: b.mediaType, data: "", src: `/api/bento/session/${encodeURIComponent(sid)}/image?tool=${encodeURIComponent(tc.id!)}&i=${k}${q}` };
            }),
          },
        };
      }),
    };
  });
}
