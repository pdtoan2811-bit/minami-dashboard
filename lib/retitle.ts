// The rolling title's trigger (§5h). Separate from lib/bento-enrich.ts only because that module is
// imported BY lib/claude-sessions.ts, and this one needs to read a session — importing it there would
// make the pair circular.
import { retitle, type Digest } from "./bento-enrich";
import { sessionMeta, type SessionMeta } from "./claude-sessions";

export const digestOf = (s: SessionMeta): Digest => ({
  id: s.id, project: s.project, title: s.title, lastPrompt: s.lastPrompt, toolNames: s.toolNames, messages: s.messages,
  lastRole: s.lastRole, tail: s.tail, active: s.active, asks: s.asks, askCount: s.askCount,
});

/** Called when a live turn ends. Cheap when nothing is due: a stat-backed summary and a count check.
 *  Delayed a beat because the CLI appends the turn's last lines to the JSONL just after `result`. */
export function retitleSoon(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  setTimeout(() => {
    const m = sessionMeta(sessionId);
    if (m) void retitle([digestOf(m)]);
  }, 1500);
}
