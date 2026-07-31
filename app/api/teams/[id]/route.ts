import { getAgent } from "@/lib/agents/store";
import type { AgentDef } from "@/lib/agents/types";
import { removeTeamBlock, writeTeamBlock } from "@/lib/teams/repo-hook";
import { listRuns } from "@/lib/teams/runs";
import { deleteProduct, getProduct, updateProduct } from "@/lib/teams/store";
import { getTemplate, summarize } from "@/lib/teams/templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = getProduct(id);
  if (!product) return Response.json({ error: "no such product" }, { status: 404 });
  const template = getTemplate(product.templateId);
  const team = Object.entries(product.roles).map(([role, agentId]) => ({
    role,
    agentId,
    agent: getAgent(agentId),
  }));
  return Response.json({
    product,
    template: template ? summarize(template) : null,
    team,
    runs: listRuns(product.id, 25),
  });
}

/** Only the things that are genuinely config. The role map isn't one — see createProduct(). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await req.json();
    const patch: Record<string, unknown> = {};
    if (typeof body?.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (typeof body?.sync === "boolean") patch.sync = body.sync;
    const product = updateProduct(id, patch);
    if (!product) return Response.json({ error: "no such product" }, { status: 404 });

    // Rewrite the repo block so a renamed product doesn't leave a stale name in someone's CLAUDE.md.
    const template = getTemplate(product.templateId);
    if (template && product.workspace) {
      const agents = new Map<string, AgentDef>();
      for (const [role, agentId] of Object.entries(product.roles)) {
        const a = getAgent(agentId);
        if (a) agents.set(role, a);
      }
      writeTeamBlock(product, template, agents);
    }
    return Response.json({ ok: true, product });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 400 });
  }
}

/**
 * Forget a product. The record folder and the role brains stay — the record is the accumulated
 * understanding of this product and the brains are shared with every other product on the box.
 * The one thing that IS cleaned up is the block this app wrote into someone else's repo.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = getProduct(id);
  if (!product) return Response.json({ error: "no such product" }, { status: 404 });
  const unhooked = product.workspace ? removeTeamBlock(product.workspace) : false;
  const ok = deleteProduct(id);
  return Response.json({ ok, keptRecord: product.recordPath, unhooked });
}
