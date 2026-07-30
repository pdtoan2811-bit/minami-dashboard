import { sendMessage } from "@/lib/agent/manager";
import { onboardingPrompt } from "@/lib/agents/onboard";
import { chatKey } from "@/lib/agents/runner";
import { inspect } from "@/lib/agents/scaffold";
import { getAgent, updateAgent } from "@/lib/agents/store";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

/**
 * Start the onboarding interview in the agent's OWN chat pane.
 *
 * Not a task run, and not a background job: this one has to be attended. The whole design is that the
 * agent interviews you with AskUserQuestion cards and writes the folder from your answers, so it goes
 * through the same key the agent's chat tab is watching (`agent:<id>:chat`) — you open the tab, the
 * questions are already there, and answering them is what fills the folder.
 *
 * `onboardedAt` is stamped on dispatch rather than on completion, deliberately. There's no reliable
 * signal for "the interview finished" (it's a conversation, it can trail off and be picked up later),
 * and the flag's only job is to stop the roster nagging about an agent you've already sat down with.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const agent = getAgent(id);
    if (!agent) return Response.json({ error: "no such agent" }, { status: 404 });
    const rep = inspect(agent.home, PROJECTS);
    if (!rep.isDir) return Response.json({ error: `home folder is missing: ${agent.home}` }, { status: 400 });

    sendMessage({
      key: chatKey(agent.id),
      cwd: agent.home,
      message: onboardingPrompt(agent, { adopted: !agent.scaffolded }),
      mode: agent.permissionMode,
      model: agent.model,
    });
    updateAgent(agent.id, { onboardedAt: Date.now() });
    return Response.json({ ok: true, key: chatKey(agent.id) });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
