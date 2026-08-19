// THE MEETING LIBRARY — every archived call, and the search across them.
//
// The archive has been written correctly for weeks and been almost unreadable: folders on disk with
// no way in except Finder. This is the read side.
//
//   GET /api/meetings            list, newest first
//   GET /api/meetings?q=…        full-text across titles, cards AND transcripts
//   GET /api/meetings?id=<slug>  one meeting in full
//
// ── Why it reads the files rather than a database ───────────────────────────────────────────────
// Thomas's whole stack is plain files: deck.json, cv-data, registry.json, each with a generated
// markdown view for Obsidian. A database would win on query speed and lose the two properties that
// system actually runs on — readable on his phone, and versioned by git. At a few hundred meetings a
// linear scan is milliseconds, and the day that stops being true an index file is the fix, not a
// server.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.CANVAS_ARCHIVE_DIR || `${process.env.HOME}/.minami/meetings`;

type Card = { id: string; kind: string; label: string; detail?: string; parent?: string };

function readMeeting(dir: string, withBody = false) {
  const p = join(ROOT, dir);
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(readFileSync(join(p, "canvas.json"), "utf8")); } catch { /* unreadable */ }
  const graph = (meta.graph ?? {}) as { nodes?: Card[]; edges?: unknown[] };
  const nodes = graph.nodes ?? [];
  const cards = nodes.filter((n) => n.kind !== "topic");
  const topics = nodes.filter((n) => n.kind === "topic" && n.id !== "root").map((n) => n.label);

  let transcript: string[] = [];
  if (withBody) {
    try {
      transcript = readFileSync(join(p, "transcript.md"), "utf8")
        .split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    } catch { /* none */ }
  }

  // The folder name carries the timestamp; parsing it beats trusting a field, because the folder is
  // what anh sees in Finder and the two must never disagree.
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})-(.*)$/.exec(dir);
  return {
    id: dir,
    date: m?.[1] ?? dir.slice(0, 10),
    time: m ? `${m[2]}:${m[3]}` : "",
    /** The FOLDER name wins over canvas.json's title whenever that title is the generic placeholder.
     *  Archives written before the naming fix all carry title:"Meeting" while their folder already
     *  holds the real topic — trusting the field would render a library where every row says the same
     *  word, which is exactly the state anh saw. */
    title: deriveTitle(nodes) ?? pickTitle(meta.title as string | undefined, m?.[4]),
    minutes: Number(meta.minutes ?? 0),
    cost: Number(meta.cost ?? 0),
    cards: cards.length,
    topics,
    ...(withBody ? { graph, transcript, notes: safeRead(join(p, "notes.md")) } : {}),
  };
}

/** ⚠️ THE FIRST TOPIC IS ALWAYS THE WORST ONE.
 *
 *  Archives were named from the biggest topic, which in practice meant the FIRST topic — and a
 *  meeting opens with small talk, so every folder came out as "Khởi động", "Thảo luận chung",
 *  "Triển khai": true, generic, and useless in a list of thirty. Meanwhile the second and third
 *  topics were the actual subjects — "Second Brain", "canvas", "Demo mua domain".
 *
 *  Ranking by how many cards hang off a topic surfaces what was really discussed rather than what was
 *  said first, and joining the top two gives a title that reads like a subject instead of a label.
 *  Computed at READ time, so meetings already on disk get better names without being rewritten. */
function deriveTitle(nodes: Card[] | undefined): string | null {
  if (!nodes?.length) return null;
  const kids = new Map<string, number>();
  const depthCount = (id: string, seen = new Set<string>()): number => {
    let n = 0;
    for (const c of nodes) {
      if (c.parent === id && !seen.has(c.id)) { seen.add(c.id); n += 1 + depthCount(c.id, seen); }
    }
    return n;
  };
  const topics = nodes.filter((n) => n.kind === "topic" && n.id !== "root");
  for (const t of topics) kids.set(t.id, depthCount(t.id));
  const ranked = topics
    .filter((t) => (t.label ?? "").trim().length > 1)
    .sort((a, b) => (kids.get(b.id) ?? 0) - (kids.get(a.id) ?? 0));
  if (!ranked.length) return null;
  const parts = ranked.slice(0, 2).map((t) => t.label.trim());
  // A single rich topic beats two words glued together; two only when both carry weight.
  if (parts.length === 2 && (kids.get(ranked[1].id) ?? 0) >= 2) return parts.join(" · ");
  return parts[0];
}

function pickTitle(fromMeta: string | undefined, fromFolder: string | undefined): string {
  const folder = fromFolder?.replace(/-/g, " ").trim();
  const generic = !fromMeta || /^(meeting|cu\u1ed9c h\u1ecdp)$/i.test(fromMeta.trim());
  if (generic && folder) return folder;
  return fromMeta || folder || "Meeting";
}

const safeRead = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };

function list(): string[] {
  try {
    return readdirSync(ROOT)
      .filter((d) => !d.startsWith(".") && d !== "index.md")
      .filter((d) => { try { return statSync(join(ROOT, d)).isDirectory(); } catch { return false; } })
      .sort((a, b) => b.localeCompare(a));
  } catch { return []; }
}

/** ⚠️ THE MOST SENSITIVE DATA IN THE APP, AND IT WAS THE LEAST PROTECTED ROUTE.
 *
 *  A search here returns verbatim, speaker-attributed transcript lines from every archived client
 *  call; ?id= returns a whole meeting plus its notes. With the server bound to 0.0.0.0 that was
 *  readable by anything on the network. Same gate as ingest and control. */
const TOKEN = process.env.CANVAS_INGEST_TOKEN || "";
const OPEN = process.env.CANVAS_INGEST_OPEN === "1";
const LOCAL = process.env.CANVAS_LOCAL_CONTROL === "1";

function localOrigin(req: Request): boolean {
  const o = req.headers.get("origin") || req.headers.get("referer") || "";
  try {
    const h = new URL(o).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch { return false; }
}

export async function GET(req: Request) {
  // The library is a browser page and cannot hold a bearer token — same constraint as the canvas
  // dock, same opt-in answer. Off by default.
  const ok = (TOKEN && req.headers.get("authorization") === `Bearer ${TOKEN}`) || (LOCAL && localOrigin(req)) || OPEN;
  if (!ok) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const u = new URL(req.url);
  /** ⚠️ ACCEPT BOTH THE DECODED AND THE STILL-ENCODED FORM.
   *
   *  Next's dynamic `params` can hand back a segment that is still percent-encoded, and the page then
   *  encodeURIComponent()s it again — so a Vietnamese folder like "Triển-khai" arrived here as the
   *  literal string "Tri%E1%BB%83n-khai", missed the allowlist, and every meeting with a diacritic in
   *  its name 404'd. Which, given the whole product transcribes Vietnamese, was most of them.
   *
   *  Decoding here rather than in the page fixes it for any caller. The allowlist still does the
   *  security work — the decoded value is matched against readdirSync output, never joined blindly. */
  const raw = u.searchParams.get("id");
  let id = raw;
  if (raw && !list().includes(raw)) {
    try {
      const dec = decodeURIComponent(raw);
      if (list().includes(dec)) id = dec;
    } catch { /* malformed escape — fall through to the 404 below */ }
  }
  if (id) {
    // The allowlist below is what actually prevents traversal — readdirSync never returns ".." or a
    // separator. This is belt and braces so the safety does not rest solely on nobody ever
    // "optimising" the allowlist into an existsSync(join(ROOT, id)).
    if (id.includes("/") || id.includes("\\") || id.startsWith(".")) {
      return Response.json({ ok: false, error: "bad id" }, { status: 400 });
    }
    if (!list().includes(id)) return Response.json({ ok: false, error: "no such meeting" }, { status: 404 });
    return Response.json({ ok: true, meeting: readMeeting(id, true) });
  }

  const q = (u.searchParams.get("q") || "").trim().toLowerCase();
  const all = list().map((d) => readMeeting(d, !!q));

  if (!q) return Response.json({ ok: true, meetings: all });

  /** Search covers the TRANSCRIPT as well as the cards, deliberately. The board is a summary; the
   *  thing anh half-remembers saying is usually a sentence that never became a card. Each hit
   *  returns the matching line so the result is an answer, not just a folder to go open. */
  const hits = all
    .map((m) => {
      const inTitle = m.title.toLowerCase().includes(q);
      const cardHits = ((m as { graph?: { nodes?: Card[] } }).graph?.nodes ?? [])
        .filter((n) => `${n.label} ${n.detail ?? ""}`.toLowerCase().includes(q))
        .map((n) => ({ kind: n.kind, text: n.label }));
      const lineHits = ((m as { transcript?: string[] }).transcript ?? [])
        .filter((l) => l.toLowerCase().includes(q));
      const score = (inTitle ? 10 : 0) + cardHits.length * 3 + lineHits.length;
      return { ...m, graph: undefined, transcript: undefined, notes: undefined, score, cardHits, lineHits: lineHits.slice(0, 4) };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);

  return Response.json({ ok: true, q, meetings: hits });
}
