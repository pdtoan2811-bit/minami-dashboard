import { decide } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { key, id, decision: "allow" | "deny", message? } → resolve a pending tool-permission prompt.
export async function POST(req: Request) {
  try {
    const { key, id, decision, message } = await req.json();
    if (!key || !id || (decision !== "allow" && decision !== "deny")) {
      return Response.json({ error: "key, id and decision (allow|deny) are required" }, { status: 400 });
    }
    const ok = decide(key, id, decision, message);
    return Response.json({ ok });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
