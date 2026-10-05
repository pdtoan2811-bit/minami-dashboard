import { vapidKeys } from "@/lib/push/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → { publicKey } — the VAPID application server key a browser subscribes against (§24).
export function GET() {
  return Response.json({ publicKey: vapidKeys().publicKey });
}
