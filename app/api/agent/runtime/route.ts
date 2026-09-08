import { sdkClaudeVersion } from "@/lib/runtime-version";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → { cliVersion } — the Claude Code the SDK will actually spawn, so the model picker can grey
// out an id this runtime would reject. Its own tiny route rather than a field on /api/accounts: the
// picker is not an account surface, and hanging a model question off the token-slayer bridge would
// couple a dropdown to a poll that can 502 when the CLI isn't installed.
export async function GET() {
  return Response.json({ cliVersion: sdkClaudeVersion() });
}
