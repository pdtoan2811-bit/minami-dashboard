import { replyDm } from "@/lib/team-inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { ts, text } → your reply to a teammate's plain DM, sent as you. Needs the user token (§25).
export async function POST(req: Request) {
  const { ts, text } = await req.json().catch(() => ({}));
  if (typeof ts !== "string" || typeof text !== "string" || !text.trim()) return Response.json({ ok: false, error: "ts and text are required" }, { status: 400 });
  const r = await replyDm(ts, text.trim());
  return Response.json(r, { status: r.ok ? 200 : 409 });
}
