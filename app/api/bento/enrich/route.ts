import { enrich, retitle, type Digest } from "@/lib/bento-enrich";
import { digestOf } from "@/lib/retitle";
import { listSessions } from "@/lib/claude-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST → summarize any sessions missing a fresh task/topic (Haiku, cached). Returns the enrichment map.
export async function POST() {
  try {
    const digests: Digest[] = listSessions().map(digestOf);
    const map = await enrich(digests);
    // Chats that moved on while nobody had them open (a terminal session, another pane): catch their
    // rolling title up too. Not awaited — the board only needs the labels above to render.
    void retitle(digests);
    return Response.json({ enrichment: map });
  } catch {
    return Response.json({ enrichment: {} });
  }
}
