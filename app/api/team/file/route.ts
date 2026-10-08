import { fetchFile } from "@/lib/team-inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET ?id=<slack file id> → the attachment, streamed with the user token. Only ids that appeared in
// a listed DM are served, so this can't be pointed at arbitrary workspace files (§25).
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!/^F[A-Z0-9]+$/.test(id)) return new Response("bad id", { status: 400 });
  return fetchFile(id);
}
