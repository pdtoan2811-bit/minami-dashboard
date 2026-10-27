import { harnessWindow } from "@/lib/harness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { show: boolean } → the harness browser's window on this Mac's screen, or parked off-screen again (§36).
// Hiding also exports its cookies, so a login done in the window reaches the chats at once.
export async function POST(req: Request) {
  const { show } = await req.json().catch(() => ({}));
  const r = await harnessWindow(show === true);
  return Response.json(r, { status: r.ok ? 200 : 500 });
}
