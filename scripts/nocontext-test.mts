// Does the judge go quiet when a meeting starts with no context?
//
// Reported: "I leave no context for the meeting, then no card created." Same utterances both ways —
// the only difference is whether a context and a topic backbone exist.

import { readFileSync } from "node:fs";
import { deriveActions, noSpend } from "../lib/canvas-llm";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const cfg = { model: "~deepseek/deepseek-v4-flash-latest", strictSchema: true, latencyRouting: true, relateModel: "", tidyModel: "" };

// Real-shaped utterances from a meeting: substantive, ordinary, nothing exotic.
const CHUNKS = [
  "phạm đức toàn: Em đã lắp cái dashboard mới rồi, dữ liệu đổ về từ Elasticsearch mỗi mười lăm phút.",
  "phạm đức toàn: Vấn đề là cái checkout metric nó lệch so với bên Shopify khoảng năm phần trăm.",
  "phạm đức toàn: Thôi chốt là tuần sau mình sẽ đối chiếu lại toàn bộ, anh Alex lo phần query.",
];

async function run(label: string, opts: Parameters<typeof deriveActions>[4], topics: string[]) {
  let total = 0;
  const got: string[] = [];
  for (const c of CHUNKS) {
    const spend = noSpend();
    try {
      const a = await deriveActions(topics, c, [], got.slice(-10), { ...opts, cfg, spend, revise: true });
      total += a.length;
      for (const x of a) if (x.label) got.push(String(x.label));
    } catch (e) {
      console.log(`    threw: ${e instanceof Error ? e.message.slice(0, 60) : e}`);
    }
  }
  console.log(`  ${label.padEnd(28)} ${total} action(s) across ${CHUNKS.length} chunks`);
  for (const g of got) console.log(`      · ${g.slice(0, 66)}`);
  return total;
}

const withCtx = await run("WITH context + topics", { context: "Buổi review dashboard dữ liệu ecommerce" }, ["Dashboard", "Dữ liệu"]);
const without = await run("NO context, no topics", {}, []);
console.log(`\n  difference: ${withCtx} vs ${without}`);
