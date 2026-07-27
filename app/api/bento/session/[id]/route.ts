import { getSession } from "@/lib/claude-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return Response.json(getSession(id));
  } catch {
    return Response.json({ meta: null, turns: [] });
  }
}
