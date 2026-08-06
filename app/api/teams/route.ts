import { getAgent } from "@/lib/agents/store";
import type { AgentDef } from "@/lib/agents/types";
import { writeTeamBlock } from "@/lib/teams/repo-hook";
import { listRuns } from "@/lib/teams/runs";
import { createProduct, listProducts, RECORDS_ROOT } from "@/lib/teams/store";
import { getTemplate, summarize, TEMPLATES } from "@/lib/teams/templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Templates and products, with each product's recent runs joined on.
 *
 * The runs ride along for the same reason the agent roster's recent tasks do (§14.6): the Teams view
 * polls, and one request per product per tick is an N+1 that grows with the roster. They're already in
 * hand here.
 */
export async function GET() {
  try {
    const products = listProducts().map((p) => {
      const runs = listRuns(p.id, 5);
      return {
        ...p,
        template: getTemplate(p.templateId) ? summarize(getTemplate(p.templateId)!) : null,
        runs,
        running: runs.filter((r) => r.status === "running").length,
      };
    });
    return Response.json({
      templates: TEMPLATES.map(summarize),
      products,
      recordsRoot: RECORDS_ROOT,
    });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e), templates: [], products: [] }, { status: 500 });
  }
}

/**
 * Create a product: resolve the template, make sure every role has a brain, and wire the workspace.
 *
 * The CLAUDE.md write is reported back rather than done quietly. It edits a tracked file in someone's
 * repo — a surprise in `git status` half an hour later is exactly the kind of thing that makes people
 * distrust a tool that is otherwise behaving correctly.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { product, createdAgents } = createProduct({
      name: String(body?.name || ""),
      templateId: String(body?.templateId || ""),
      workspace: typeof body?.workspace === "string" && body.workspace.trim() ? body.workspace : undefined,
      recordPath: typeof body?.recordPath === "string" && body.recordPath.trim() ? body.recordPath : undefined,
      sync: body?.sync === true,
    });

    const template = getTemplate(product.templateId)!;
    const agents = new Map<string, AgentDef>();
    for (const [role, id] of Object.entries(product.roles)) {
      const a = getAgent(id);
      if (a) agents.set(role, a);
    }
    // Opt-out rather than opt-in: the block is what makes the team reachable from a bare `claude` in
    // that folder, which is most of the point of attaching a workspace at all.
    const hook = body?.repoHook === false ? null : writeTeamBlock(product, template, agents);

    return Response.json({ ok: true, product, createdAgents, hook });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 400 });
  }
}
