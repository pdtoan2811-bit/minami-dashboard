// THE BASELINE — every failure that has actually cost a meeting, checked in about a minute.
//
//   npx tsx scripts/regression.mts
//
// Written after a day in which four separate fixes each caused the next problem: an empty
// transcription treated as an error, a receiver that identified itself while forwarding nothing, a
// tunnel check that accepted Cloudflare's API, and five "return nothing" rules that quietly stopped
// the judge doing its job. Every one of those was invisible until a real meeting hit it.
//
// The rule this encodes: BEFORE editing a prompt or a health check, run this. After, run it again.
// Nothing here is hypothetical — each case is a thing that broke on a real call.
//
// Model calls cost about a cent in total. That is the cheapest part of any of these bugs.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
// The ear is chosen in code; a stale shell export has silently overridden it before.
delete process.env.CANVAS_STT_MODEL;

const { loadVocab, asrPrompt, correctLines } = await import("../server/canvas-vocab.mjs");
const { createBoard } = await import("../lib/canvas-board");
const { deriveActions, noSpend } = await import("../lib/canvas-llm");

const cfg = { model: "~deepseek/deepseek-v4-flash-latest", strictSchema: true, latencyRouting: true, relateModel: "", tidyModel: "" };

let failed = 0;
const ok = (n: string, d = "") => console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ""}`);
const bad = (n: string, d: string) => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${n}\n      \x1b[31m${d}\x1b[0m`); };
const check = (n: string, pass: boolean, d = "") => (pass ? ok(n, d) : bad(n, d || "failed"));

console.log("\n\x1b[1m  VOCABULARY\x1b[0m");
{
  const v = await loadVocab();
  const sent = asrPrompt(v, ["Recall", "screenshare"]).replace(/^[^:]*:\s*/, "").replace(/\.$/, "").split(/,\s*/);
  // A short name missing from the list gets promoted to whatever longer one IS there.
  check("bare 'Claude' reaches the ear", sent.includes("Claude"), "without it, 'Claude' becomes 'CLAUDE.md'");
  check("'CLAUDE.md' is NOT offered to the ear", !sent.includes("CLAUDE.md"), "a filename must not compete with the product name");
  // The live glossary was once cut entirely by the 40-term cap.
  check("live keyterms survive the cap", sent.includes("Recall") && sent.includes("screenshare"), "words from THIS meeting matter most");
  const { corrected } = correctLines(["T: ghi vào cloud md nhé"], v);
  check("mishearing fixes still apply", corrected[0].includes("CLAUDE.md"), corrected[0]);
}

console.log("\n\x1b[1m  BOARD\x1b[0m");
{
  const b = createBoard();
  b.seedPlaceholders(["A", "B", "C"]);
  b.seedPlaceholders(["D", "E"]);
  const nodes = b.graph().nodes;
  const ghosts = nodes.filter((n) => n.placeholder);
  const ids = new Set(nodes.map((n) => n.id));
  // Three relaunches once left fifteen ghosts with every id tripled.
  check("warm-up replaces, never accumulates", ghosts.length === 2, `${ghosts.length} ghosts after two seeds`);
  check("node ids are unique", ids.size === nodes.length, `${nodes.length} nodes, ${ids.size} ids`);

  const b2 = createBoard();
  b2.apply({ op: "card", kind: "note", label: "Một điều gì đó", source: "Một điều gì đó" }, ["T: Một điều gì đó"]);
  const gone = b2.removeById("Một điều gì đó");
  const again = b2.apply({ op: "card", kind: "note", label: "Một điều gì đó", source: "Một điều gì đó" }, ["T: Một điều gì đó"]);
  // seenLabels not cleaned meant a deleted point could never be said again, silently.
  check("a deleted card can be recreated", !!gone && !!again, "index cleanup on delete");

  const b3 = createBoard();
  for (const t of ["Old1", "Old2", "Old3", "Old4", "Old5", "Old6", "Old7", "New"]) b3.topicId(t);
  b3.topicId("New");
  const offered = b3.topicNames();
  // A topic that never gets old means late speech is filed under minute three.
  check("topics are offered most-recent-first", offered[0] === "New", offered.slice(0, 3).join(", "));
  check("topic list is capped", offered.length <= 8, `${offered.length} offered`);
}

console.log("\n\x1b[1m  OPERATOR CHECKS\x1b[0m");
{
  const launcher = readFileSync(new URL("../bin/Minami Call.command", import.meta.url), "utf8");
  check("tunnel check demands our marker", launcher.includes("minami-receiver"), "'anything answered' let a bot stream to Cloudflare's API");
  check("tunnel url skips api.trycloudflare", launcher.includes("//api\\."), "cloudflared logs its API host first");
  check("dry-run receiver is refused", launcher.includes('"minami-receiver ok"'), "a dry-run receiver forwards nothing but says it is fine");
  const ws = readFileSync(new URL("../server/ws-min.mjs", import.meta.url), "utf8");
  check("receiver reports its mode", ws.includes("health?.()"), "identity is not capability");
}

console.log("\n\x1b[1m  SAFETY NETS\x1b[0m");
{
  // These are the guards that only ever matter mid-meeting, which is exactly when nobody can check
  // them. Both rescue paths must PIN the card (or the tidy pass rewrites a raw quote) and must move
  // lastCardAt (or the switch fires again on the very next chunk and floods the board).
  const ing = readFileSync(new URL("../app/api/canvas/ingest/route.ts", import.meta.url), "utf8");
  const rescues = ing.split("editById?.(node.id, {})").length - 1;
  check("both verbatim rescues exist", rescues === 2, `${rescues} found — one for a judge that threw, one for a judge that went quiet`);
  check("a rescue counts as a card", (ing.split("s.lastCardAt = Date.now()").length - 1) >= 3, "otherwise the switch re-fires every chunk");
  const m = /const DEAD_MAN_MS = ([\d_]+)/.exec(ing);
  const ms = Number(m?.[1]?.replace(/_/g, ""));
  check("dead-man's window is sane", ms >= 45_000 && ms <= 180_000, `${ms / 1000}s — under 45s fires on ordinary quiet, over 180s is a gap the room already noticed`);
}

console.log("\n\x1b[1m  THE JUDGE\x1b[0m  \x1b[2m(model calls)\x1b[0m");
{
  // Eight substantive utterances once produced zero cards, on a live call.
  const REAL = [
    "T: Em đã lắp cái dashboard mới rồi, dữ liệu đổ về từ Elasticsearch mỗi mười lăm phút.",
    "T: Em cũng thấy là cái Minami của em, em đang định hướng là em sẽ làm một cái mind map.",
    "T: Thôi chốt là tuần sau mình sẽ đối chiếu lại toàn bộ, anh Alex lo phần query.",
  ];
  let cards = 0;
  for (const line of REAL) {
    const a = await deriveActions([], line, [], [], { cfg, spend: noSpend(), revise: true });
    cards += a.length;
  }
  check("substantive speech produces cards", cards >= 2, `${cards} cards from ${REAL.length} real utterances (was 1 of 6 when the judge went quiet)`);

  // The counterweight: it must still refuse to invent.
  const junk = await deriveActions([], "T: Ừ. Và", [], [], { cfg, spend: noSpend(), revise: true });
  check("a fragment still produces nothing", junk.length === 0, `${junk.length} cards from "Ừ. Và"`);
}

console.log("\n\x1b[1m  TYPES\x1b[0m");
try {
  execFileSync("npx", ["tsc", "--noEmit"], { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe" });
  ok("tsc --noEmit");
} catch (e) {
  const out = String((e as { stdout?: Buffer }).stdout ?? "").split("\n").filter((l) => l.includes("error") && !/FlowCanvas|flow-model|flow-stack/.test(l));
  check("tsc --noEmit", out.length === 0, out.slice(0, 3).join("\n      "));
}

console.log(failed ? `\n  \x1b[31m${failed} check(s) failed\x1b[0m\n` : `\n  \x1b[32mall checks passed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
