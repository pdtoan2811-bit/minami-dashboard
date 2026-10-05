import { act } from "@/lib/push/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { nonce, endpoint } → run the notification button that nonce was minted for (§24).
//
// The dashboard is unauthenticated on the tailnet, so this route is the one place a notification can
// change a session, and it accepts nothing but a one-time nonce: bound to one session, one prompt, one
// action and the device it was pushed to, expiring with the prompt (≤ 15 min). It never takes a
// sessionId or a decision from the request — /api/agent/permission already does that for the app,
// and a second door shaped like it would only be a second thing to secure.
export async function POST(req: Request) {
  try {
    const { nonce, endpoint } = await req.json();
    if (typeof nonce !== "string" || typeof endpoint !== "string") return Response.json({ error: "nonce and endpoint required" }, { status: 400 });
    const r = await act(nonce, endpoint);
    return Response.json(r, { status: r.ok ? 200 : r.reason === "invalid or used" ? 403 : 409 });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
