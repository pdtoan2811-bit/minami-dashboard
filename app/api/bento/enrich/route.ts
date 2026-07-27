import { enrich, type Digest } from "@/lib/bento-enrich";
import { listSessions } from "@/lib/claude-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST → summarize any sessions missing a fresh task/topic (Haiku, cached). Returns the enrichment map.
export async function POST() {
  try {
    const digests: Digest[] = listSessions().map((s) => ({
      id: s.id, project: s.project, title: s.title, lastPrompt: s.lastPrompt, toolNames: s.toolNames, messages: s.messages,
    }));
    const map = enrich(digests);
    return Response.json({ enrichment: map });
  } catch {
    return Response.json({ enrichment: {} });
  }
}
