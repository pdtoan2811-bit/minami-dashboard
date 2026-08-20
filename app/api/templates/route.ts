// GET /api/templates — the meeting shapes anh can start from.
//
// Read-only and unauthenticated for the same reason /api/memes is: a template is a list of topic
// names he wrote himself, exposing nothing a meeting would not put on a screen anyway.

import { listTemplates } from "@/server/canvas-templates.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true, templates: listTemplates() });
}
