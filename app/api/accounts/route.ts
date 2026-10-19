import { checkModelPins } from "@/lib/model-pins";
import { liveModels } from "@/lib/agent/manager";
import { readPreferred, writePreferred, isPinned, readOnLimit, writeOnLimit, liveIdentity } from "@/lib/preferred-account";
import { lastFailover } from "@/lib/account-failover";
import { runTok as run } from "@/lib/token-slayer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The account we WANT to be running on is chosen in Settings and stored on disk — see
// lib/preferred-account.ts for why it can't be a `useSetting`. Read per-request so a change in the UI
// lands on the next 30s poll. The live identity comes from ~/.claude.json, not token-slayer's
// `active` label; liveIdentity() in the same file says why.

// GET /api/accounts → the account pool + live usage, straight from `token-slayer status --json`,
// plus a `live` block carrying the real authenticated identity (liveIdentity, lib/preferred-account.ts) and the
// model-pin drift check.
//
// Both drift signals ride this one route on purpose: the alert component polls it every 30s, and
// "which account am I burning" and "which model am I burning it on" are the same question asked
// twice. Splitting them into two routes would double the poll for no gain.
export async function GET() {
  const { ok, stdout, stderr } = await run(["status", "--json"]);
  if (!ok) return Response.json({ error: stderr || "token-slayer status failed" }, { status: 502 });
  try {
    const doc = JSON.parse(stdout);
    const live = liveIdentity();
    const preferred = readPreferred();
    return Response.json({
      ...doc,
      live: {
        ...live,
        preferred,
        // Whether someone actually chose it, vs. it being the shipped fallback. Settings shows
        // this so an unpinned default doesn't masquerade as a deliberate decision.
        preferredPinned: isPinned(),
        // The alert's trigger: we know who we really are, and it isn't who we want to be.
        //
        // `preferred` is empty until someone chooses one (the shipped default is deliberately blank
        // — see lib/preferred-account.ts), and with no preferred account there is no such thing as
        // being off it. Without this guard a fresh clone alerts forever against "", which reads as
        // "you are on the wrong account" to someone who has not yet been asked which account is right.
        offPreferred: preferred !== "" && live.email != null && live.email !== preferred,
        // §6b. The account a usage limit switches to ("" = off), and the newest failover attempt in
        // the last 12h — including the ones that could not switch, which are the ones to show.
        onLimit: readOnLimit(),
        failover: lastFailover(),
        // The CLI's own banner disagreeing with reality — worth surfacing separately, because it
        // means "just switch back" may report success without actually changing anything.
        claimsMismatch: live.email != null && typeof doc?.active === "string" && doc.active !== live.email,
        // What each spawner will run on its NEXT turn, and whether any has fallen off the pin.
        models: checkModelPins(),
        // ...and the runtime half: sessions ALREADY born on a premium model, which the config check
        // cannot see (a warm session keeps its model, so the pin can read green while a pane burns 2×).
        // Only the premium ones — this is an alert feed, not a session census.
        premiumSessions: liveModels()
          .filter((m) => m.premium)
          .map((m) => ({ cwd: m.cwd, model: m.model, busy: m.busy })),
      },
    });
  } catch {
    return Response.json({ error: "unparsable token-slayer output" }, { status: 502 });
  }
}

// POST /api/accounts { target } → switch the active Claude account slot.
export async function POST(req: Request) {
  let target = "";
  try { ({ target } = await req.json()); } catch { /* bad body */ }
  if (!target || typeof target !== "string") {
    return Response.json({ error: "missing target" }, { status: 400 });
  }
  const { ok, stdout, stderr } = await run(["switch", target]);
  if (!ok) return Response.json({ error: stderr || "switch failed" }, { status: 502 });
  return Response.json({ ok: true, output: stdout });
}

// PUT /api/accounts { preferred } → change which account the alert measures against.
// PUT /api/accounts { onLimit }   → change which account a usage limit switches to ("" = off, §6b).
//
// Deliberately separate from POST: POST *switches the live credential* (a side effect that kills
// every running `claude` on the box), PUT only records an intention. Conflating them would mean
// picking a target in Settings silently rewrote the Keychain and dropped your sessions.
export async function PUT(req: Request) {
  let preferred: unknown;
  let onLimit: unknown;
  try { ({ preferred, onLimit } = await req.json()); } catch { /* bad body */ }
  // `onLimit` may be "" — that is how the failover is turned off.
  const settingOnLimit = typeof onLimit === "string";
  if (!settingOnLimit && (!preferred || typeof preferred !== "string")) {
    return Response.json({ error: "missing preferred or onLimit" }, { status: 400 });
  }
  const wanted = settingOnLimit ? (onLimit as string).trim() : (preferred as string);

  // Only accept an account token-slayer actually manages. A typo'd address would otherwise pin
  // the alert to an account that can never be live, leaving it stuck red with no way to read why.
  const { ok, stdout } = await run(["status", "--json"]);
  if (ok) {
    try {
      const doc = JSON.parse(stdout);
      const pool: string[] = (doc?.accounts ?? [])
        .map((a: { email?: string; name?: string }) => a.email || a.name)
        .filter((e: unknown): e is string => typeof e === "string" && e.length > 0);
      if (wanted && pool.length && !pool.includes(wanted)) {
        return Response.json(
          { error: `"${wanted}" is not in the token-slayer pool — add it first: tok add ${wanted} --login`, pool },
          { status: 400 }
        );
      }
    } catch { /* unparsable status — don't block the write on it */ }
  }

  try {
    if (settingOnLimit) writeOnLimit(wanted);
    else writePreferred(wanted);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
  return Response.json({ ok: true, preferred: readPreferred(), preferredPinned: isPinned(), onLimit: readOnLimit() });
}
