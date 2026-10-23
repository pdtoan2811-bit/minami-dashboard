import { sessionIdentity } from "@/lib/agent/manager";
import { publishOf, readFinished, readUploads } from "@/lib/upload-progress";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → { publishes } for the Bento publish tile (§33): every live publish on the machine, whichever chat started it,
// then the ones that ended in the last 6 hours (the writer's done/ copies). `sessionId` is the chat to open from the
// tile: a writer's key is either `live:<sid>` already or a pane key the live store still knows.
export async function GET() {
  const sidOf = (key: string | null) => !key ? null : key.startsWith("live:") ? key.slice(5) : sessionIdentity(key)?.sessionId ?? null;
  const publishes = [...readUploads(), ...readFinished()].map((p) => ({ ...publishOf(p), sessionId: sidOf(p.session) }));
  return Response.json({ publishes });
}
