import { act, track, type AttnView } from "@/lib/attention";
import { sessionIdentity } from "@/lib/agent/manager";
import { publishBrief, publishOf, readFinished, readUploads, type Publish } from "@/lib/upload-progress";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const all = () => {
  const sidOf = (key: string | null) => !key ? null : key.startsWith("live:") ? key.slice(5) : sessionIdentity(key)?.sessionId ?? null;
  return [...readUploads(), ...readFinished()].map((p) => ({ ...publishOf(p), sessionId: sidOf(p.session) }));
};

// GET → { publishes } for the Bento publish tile (§33): every live publish on the machine, whichever chat started it,
// then the ones that ended in the last 6 hours (the writer's done/ copies). `sessionId` is the chat that started it: a
// writer's key is either `live:<sid>` already or a pane key the live store still knows. Each carries `att`, its entry in
// the attention store (§34, scope "publish"), which holds his comments and the Minami chats asked from the tile.
export async function GET() {
  const list = all();
  const { flagged } = track("publish", list.map((p) => ({ key: p.key, sig: "publish", meta: { title: p.label } })), () => "the publish ended");
  return Response.json({ publishes: list.map((p) => ({ ...p, att: flagged[p.key] as AttnView | undefined })) });
}

// POST { op: "comment" | "ask", key, text } — the tile's input, the same hand as every flagged item (§34): Comment saves
// the note; ask (Enter / "Minami ↵") starts a chat in the publish's own folder with the publish as its subject, and
// records the chat on it. A new chat rather than a message into the chat that started the publish: that one may be
// mid-turn, and a second driver on one conversation is what manager.ts refuses.
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const text = String(b?.text || "").trim();
    const p = all().find((x) => x.key === b?.key) as Publish | undefined;
    if (!p) return Response.json({ error: "that publish is gone" }, { status: 404 });
    if (!text) return Response.json({ error: "say what you want done" }, { status: 400 });
    if (b.op === "comment") return Response.json({ att: act({ op: "comment", key: p.key, text }) });
    if (b.op !== "ask") return Response.json({ error: "op must be comment or ask" }, { status: 400 });
    const { sendMessage, liveStats } = await import("@/lib/agent/manager");
    const key = `publish:ask:${p.pid}:${Date.now()}`;
    // The first line is the chat's name on the board (§5h).
    const message = `Publish · ${text.slice(0, 180)}\n\nThomas asked this from the publish tile on Bento. What the progress file says now:\n\n${publishBrief(p)}\n\n` +
      `The publish is tiktok-studio's \`node scripts/uploads.mjs publish\`; its progress file is ~/.harness/progress/${p.pid}.json (done/${p.pid}.json once it ended).\n\n` +
      "Answer first, plainly and short. If something is broken, say what you'd fix and ask before changing anything, unless the fix is trivial and safe. Never kill or restart a running publish without asking, and never post as Thomas.";
    let { sessionId } = sendMessage({ key, cwd: p.cwd, message });
    for (let i = 0; !sessionId && i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      sessionId = liveStats().details.find((d) => d.key === key)?.sessionId ?? null;
    }
    if (!sessionId) return Response.json({ error: "the chat didn't start in time — look for it on the board" }, { status: 504 });
    return Response.json({ att: act({ op: "chat", key: p.key, sessionId, text }), sessionId });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 400 });
  }
}
