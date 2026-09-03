import { AUTO_ISOLATE, discardIfPristine, isolate, isolateMode, mergeBack, repoInfo } from "@/lib/worktree";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The three things the dashboard needs to do with an isolated chat: make one, fold it back, throw an
// unused one away. Everything it knows about worktrees goes through here — see lib/worktree.ts for why
// creation belongs to the UI rather than to the autopilot.
//
// POST { action: "isolate", cwd, label }  → { isolated: {dir,branch,name} | null }
// POST { action: "merge",   cwd }         → { ok, message }
// POST { action: "discard", cwd }         → { discarded }
//
// `isolated: null` is a SUCCESS, not a failure: "this folder isn't a repo", "you're already in a
// worktree" and "isolation is switched off" all mean carry on in the shared folder, and a caller that
// had to tell those apart from an error would end up re-implementing the policy on the client.
export async function POST(req: Request) {
  try {
    const { action, cwd, label } = await req.json();
    if (!cwd || typeof cwd !== "string") return Response.json({ error: "cwd is required" }, { status: 400 });

    if (action === "isolate") {
      const isolated = await isolate(cwd, String(label || "chat"));
      return Response.json({ isolated, enabled: AUTO_ISOLATE });
    }
    if (action === "merge") return Response.json(await mergeBack(cwd));
    if (action === "discard") return Response.json({ discarded: await discardIfPristine(cwd) });
    return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

// Is this folder isolatable, and is the switch on? The composer asks before it offers anything, so a
// non-repo folder never grows controls that cannot work there.
export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd") || "";
  if (!cwd) return Response.json({ enabled: AUTO_ISOLATE, repo: null });
  const repo = await repoInfo(cwd);
  // `mode` rides along so the shared-folder banner can tell a DANGEROUS overlap (eager repo, two
  // writers, one branch) from a DESIGNED one (lazy repo — the placement pass isolates on the first
  // contended write). The git config lives server-side; without this the client can only assume
  // eager and cry wolf at every vault chat.
  return Response.json({ enabled: AUTO_ISOLATE, repo, mode: repo ? await isolateMode(repo.base) : null });
}
