// Shared by the server (which reads the roster off disk) and the ask card (which renders it).
// Kept free of node imports on purpose: `lib/team-roster.ts` uses node:fs, and importing that from
// a client component pulls fs into the browser bundle.

export type TeamMember = { key: string; name: string; role?: string; expertise?: string[] };

/** The answer text a forwarded question resolves to.
 *
 *  The dashboard has no Slack of its own and deliberately doesn't grow one: team-ask is an MCP
 *  server the session already holds, so the cheapest correct move is to answer Claude's question
 *  with an instruction to go ask that person itself. One Slack integration on this box, not two —
 *  and it works the same in a pane, a terminal, or a headless agent. §3 of
 *  docs/knowledge/03-live-sessions.md. */
export function forwardInstruction(m: TeamMember, forwardedCount: number): string {
  const who = m.role ? `${m.name} (${m.role})` : m.name;
  return (
    `Not my call — ask ${who}. Use the ask_team tool with assignee "${m.key}", passing this question ` +
    `and these same options verbatim, and wait for their answer before continuing. Do not decide it yourself.` +
    (forwardedCount > 1
      ? " Several questions are being handed over this way — put the ones going to the same person in ONE ask_team call."
      : "")
  );
}
