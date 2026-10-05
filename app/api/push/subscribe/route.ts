import { device, upsertDevice } from "@/lib/push/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { subscription: PushSubscriptionJSON, finished?: boolean, replaces?: string } → upsert this
// device (§24). Also how a device changes its own "finished" pref, and how the service worker
// re-registers after pushsubscriptionchange (`replaces` = the old endpoint).
// POST { endpoint } alone → { subscribed, finished } — the toggle asking what the server holds.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const sub = body?.subscription;
    if (!sub) {
      const d = typeof body?.endpoint === "string" ? device(body.endpoint) : undefined;
      return Response.json({ subscribed: !!d, finished: d?.finished !== false });
    }
    // Only https push services: the endpoint is a URL this server will POST to on every need, so an
    // arbitrary one (http://127.0.0.1:…) would turn the subscribe route into a request forger.
    let url: URL;
    try { url = new URL(sub.endpoint); } catch { return Response.json({ error: "bad endpoint" }, { status: 400 }); }
    if (url.protocol !== "https:" || typeof sub.keys?.p256dh !== "string" || typeof sub.keys?.auth !== "string") {
      return Response.json({ error: "subscription needs an https endpoint and keys.p256dh / keys.auth" }, { status: 400 });
    }
    const d = upsertDevice(sub, {
      ua: String(req.headers.get("user-agent") || "").slice(0, 200),
      ...(typeof body.finished === "boolean" ? { finished: body.finished } : {}),
      ...(typeof body.replaces === "string" ? { replaces: body.replaces } : {}),
    });
    return Response.json({ ok: true, finished: d.finished !== false });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
