import { minamiAnswers, minamiChatFor } from "@/lib/team-chat";
import { findCard, findCardByTopic } from "@/lib/team-inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { topic, asker? } | { ts } → the Minami chat answering that card, started on the first call and
// the same one on every later call (§25). POST, not GET: the Slack button is a link to /team/minami, a
// page that calls this — a link preview or a prefetch must never be what answers a teammate.
export async function POST(req: Request) {
  const { ts, topic, asker } = await req.json().catch(() => ({}));
  const card = typeof ts === "string" ? await findCard(ts)
    : typeof topic === "string" ? await findCardByTopic(topic, typeof asker === "string" ? asker : undefined) : null;
  if (!card) return Response.json({ ok: false, error: "That question isn't in your DM any more — withdrawn, or older than two weeks." }, { status: 404 });
  const meta = { headline: card.headline || card.topic, asker: card.asker, state: card.state };
  const had = await minamiChatFor(card.ts);
  if (had) return Response.json({ ok: true, sessionId: had, fresh: false, ...meta });
  // Only an open card gets a new chat. Answered or expired: someone handled it in Slack. "sent": you
  // answered it yourself from the dashboard and team-ask hasn't closed it yet. Either way a second answer
  // would contradict the first.
  if (card.state !== "open") return Response.json({ ok: false, error: card.state === "sent" ? "You already sent an answer to this one." : `Already ${card.state} — nothing for Minami to do.`, ...meta }, { status: 409 });
  const { sessionId } = await minamiAnswers(card);
  if (!sessionId) return Response.json({ ok: false, error: "The chat didn't start in time — look for it on the board.", ...meta }, { status: 504 });
  return Response.json({ ok: true, sessionId, fresh: true, ...meta });
}
