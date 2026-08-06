import { getSession } from "@/lib/claude-sessions";
import { buildJourney } from "@/lib/flow-model";
import { NARRATE_ENABLED, narrateSession, readNarratives } from "@/lib/flow-narrate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Narratives only — never the journey itself.
//
// The canvas already fetches `/api/bento/session/<id>` and folds it with `buildJourney`, and that fold
// is where every tool input and output lives (including base64 screenshots). Returning a second, fully
// folded copy from here would double a payload that is already the heaviest thing the page fetches, to
// deliver a few hundred bytes of prose. So this endpoint answers one question — "what sentences do we
// have for this session" — and the client merges them into the fold it already has.
//
// The keys line up because a milestone is keyed on the BYTE OFFSET of the row that opened it, which is
// immutable in an append-only transcript. The server folding its own copy here and the browser folding
// the page it fetched arrive at the same keys without either telling the other anything.
//
//   GET   cached only. Free, no spawn — safe on the canvas's poll.
//   POST  narrate what's missing, then return everything. Up to ~60s; deduped per session.

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return Response.json({ narratives: readNarratives(id), enabled: NARRATE_ENABLED });
  } catch {
    return Response.json({ narratives: {}, enabled: NARRATE_ENABLED });
  }
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!NARRATE_ENABLED) return Response.json({ narratives: {}, enabled: false });
  try {
    // The server reads its own page of the transcript rather than trusting a client-supplied fold: the
    // digest that gets sent to the summariser is derived here, so a pane cannot influence what is
    // narrated or what it is told about the session.
    const page = getSession(id);
    if (!page.turns.length) return Response.json({ narratives: readNarratives(id), enabled: true });
    const narratives = await narrateSession(id, buildJourney(page.turns, readNarratives(id)));
    return Response.json({ narratives, enabled: true });
  } catch {
    return Response.json({ narratives: readNarratives(id), enabled: true });
  }
}
