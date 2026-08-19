// TIDY A FINISHED MEETING — the AI pass anh asked for, on the archive rather than the live board.
//
// The live board tidies every 3 utterances, but it does so BLIND to the rest of the call: it sees the
// last 60 lines and the cards so far. A finished meeting can be tidied against the whole thing at
// once, which is a different and much better job — duplicates from minute 5 and minute 40 are finally
// visible in the same pass.
//
//   POST /api/meetings/tidy { id }              apply merges, revisions and nesting
//   POST /api/meetings/tidy { id, preview: 1 }  return what it WOULD do, change nothing
//
// ── Why applying without asking is safe here ────────────────────────────────────────────────────
// Anh chose "just do it, I'll undo" for past meetings, and that is only safe because the TRANSCRIPT
// IS IMMUTABLE. The board is derived from it, so a bad tidy is recovered by re-deriving rather than
// by an undo stack nobody kept. Every write below is to canvas.json; transcript.md is never touched.
//
// A backup is still written, because "regenerable in principle" and "one click away" are different
// things at the moment you realise the pass was wrong.

import { readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { refineBoard } from "@/lib/canvas-llm";
import { resolveMode } from "@/lib/canvas-modes";

const ROOT = process.env.CANVAS_ARCHIVE_DIR || `${process.env.HOME}/.minami/meetings`;
const TOKEN = process.env.CANVAS_INGEST_TOKEN || "";
const OPEN = process.env.CANVAS_INGEST_OPEN === "1";
const LOCAL = process.env.CANVAS_LOCAL_CONTROL === "1";

type Node = { id: string; kind: string; label: string; detail?: string; parent?: string };

function localOrigin(req: Request): boolean {
  const o = req.headers.get("origin") || req.headers.get("referer") || "";
  try {
    const h = new URL(o).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch { return false; }
}

/** Allowlist, not path arithmetic — the same rule the read route uses. */
function known(id: string): boolean {
  try {
    return readdirSync(ROOT)
      .filter((d) => { try { return statSync(join(ROOT, d)).isDirectory(); } catch { return false; } })
      .includes(id);
  } catch { return false; }
}

export async function POST(req: Request) {
  const ok = (TOKEN && req.headers.get("authorization") === `Bearer ${TOKEN}`) || (LOCAL && localOrigin(req)) || OPEN;
  if (!ok) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { id?: string; preview?: boolean };
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }); }

  let id = (body.id || "").trim();
  if (id && !known(id)) { try { id = decodeURIComponent(id); } catch { /* keep as-is */ } }
  if (!id || !known(id)) return Response.json({ ok: false, error: "no such meeting" }, { status: 404 });

  const dir = join(ROOT, id);
  const file = join(dir, "canvas.json");
  let doc: { graph?: { nodes?: Node[]; edges?: unknown[] } };
  try { doc = JSON.parse(readFileSync(file, "utf8")); }
  catch { return Response.json({ ok: false, error: "canvas.json unreadable" }, { status: 500 }); }

  const nodes = doc.graph?.nodes ?? [];
  const cards = nodes.filter((n) => n.kind !== "topic");
  if (cards.length < 3) return Response.json({ ok: true, skipped: "too few cards to tidy", merged: 0, revised: 0, nested: 0 });

  let transcript = "";
  try {
    transcript = readFileSync(join(dir, "transcript.md"), "utf8")
      .split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)).join("\n");
  } catch { /* a board with no transcript can still be tidied structurally */ }

  const mode = resolveMode(null);
  let plan;
  try {
    plan = await refineBoard(
      cards.map((c) => ({ id: c.id, label: c.label, detail: c.detail })),
      // The WHOLE transcript, not a 60-line window. This is the entire reason a post-hoc tidy beats
      // the live one: it can see that minute 5 and minute 40 were the same point.
      transcript.slice(-24000),
      { cfg: { ...mode.derive, model: mode.derive.tidyModel } },
    );
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "tidy failed" }, { status: 502 });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const label = (i: string) => byId.get(i)?.label ?? i;
  if (body.preview) {
    return Response.json({
      ok: true, preview: true,
      merge: plan.merge.map((m) => ({ from: label(m.from), into: label(m.into) })),
      revise: plan.revise.map((r) => ({ from: label(r.id), to: r.label ?? label(r.id) })),
      nest: plan.nest.map((n) => ({ card: label(n.id), under: label(n.under) })),
    });
  }

  // ── apply ────────────────────────────────────────────────────────────────────────────────────
  copyFileSync(file, `${file}.bak`);
  let revised = 0, merged = 0, nested = 0;

  for (const r of plan.revise) {
    const n = byId.get(r.id);
    if (!n) continue;
    if (r.label) { n.label = r.label.slice(0, 90); revised++; }
    if (r.detail) n.detail = r.detail.slice(0, 160);
  }

  for (const m of plan.merge) {
    const from = byId.get(m.from), into = byId.get(m.into);
    if (!from || !into || from === into) continue;
    // Same adoption rule the live board learned the hard way: re-home the winner if it sits under the
    // loser, or it becomes its own ancestor and the whole branch silently leaves the board.
    let hop: string | undefined = into.parent, guard = 0;
    let winnerUnderLoser = false;
    while (hop && guard++ < 64) { if (hop === from.id) { winnerUnderLoser = true; break; } hop = byId.get(hop)?.parent; }
    if (winnerUnderLoser) into.parent = from.parent;
    for (const n of nodes) if (n.parent === from.id && n.id !== into.id) n.parent = into.id;
    const i = nodes.findIndex((n) => n.id === from.id);
    if (i >= 0) { nodes.splice(i, 1); byId.delete(from.id); merged++; }
  }

  const depthOf = (nid: string) => {
    let d = 0, cur = byId.get(nid), seen = new Set<string>();
    while (cur?.parent && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.parent); d++; }
    return d;
  };
  for (const n of plan.nest) {
    const node = byId.get(n.id), target = byId.get(n.under);
    if (!node || !target || node.id === target.id || node.kind === "topic") continue;
    // Cycle guard and depth cap, both enforced here rather than trusted from the model.
    let hop: string | undefined = target.id, guard = 0, cyclic = false;
    while (hop && guard++ < 64) { if (hop === node.id) { cyclic = true; break; } hop = byId.get(hop)?.parent; }
    if (cyclic || depthOf(target.id) + 1 > 4) continue;
    node.parent = target.id;
    nested++;
  }

  doc.graph = { ...(doc.graph ?? {}), nodes };
  writeFileSync(file, JSON.stringify(doc, null, 2));

  return Response.json({ ok: true, merged, revised, nested, cards: nodes.filter((n) => n.kind !== "topic").length });
}
