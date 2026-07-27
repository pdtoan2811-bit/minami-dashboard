import { getAttach } from "@/lib/tech-attach";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/bento/attach?cwd=<abs>&project=<name> → the topic's git repo + tech/brand icon slugs
// (detected from .git/package.json/config files, merged with the curated assignment store). Local-only.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const cwd = u.searchParams.get("cwd") || "";
  const project = u.searchParams.get("project") || undefined;
  return Response.json(getAttach(cwd, project));
}
