// The judge returned 0 cards for eight consecutive substantive utterances on a live call.
// These are those exact lines. If it produces nothing here, the prompt is too conservative.

import { readFileSync } from "node:fs";
import { deriveActions, noSpend } from "../lib/canvas-llm";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const cfg = { model: "~deepseek/deepseek-v4-flash-latest", strictSchema: true, latencyRouting: true, relateModel: "", tidyModel: "" };

const LIVE = [
  "phạm đức toàn: Anh sẽ demo cái setup của anh một chút, xong rồi anh sẽ đi vào cái phần chính.",
  "phạm đức toàn: Làm thêm về cái con Claude Code xong rồi em sẽ demo.",
  "phạm đức toàn: nó sẽ thông minh hơn, nó học sâu hơn, nó đang muốn hướng tới một cái gọi là trí tuệ nhân tạo",
  "phạm đức toàn: Bây giờ em thấy nó hỗ trợ mình rất nhiều, gần như là đúng là ví dụ bất kỳ cái gì em",
  "phạm đức toàn: Em cũng thấy là cái Minami của em, em đang định hướng là em sẽ làm một cái mind map.",
  "phạm đức toàn: Nếu mà mình làm được cái đó thì nó sẽ tránh bị trùng.",
];

let total = 0;
const known: string[] = [];
for (const line of LIVE) {
  const spend = noSpend();
  const a = await deriveActions([], line, [], known.slice(-10), { cfg, spend, revise: true });
  total += a.length;
  for (const x of a) if (x.label) known.push(String(x.label));
  console.log(`  ${a.length}  ${line.slice(15, 80)}`);
  for (const x of a) console.log(`       → [${x.kind}] ${String(x.label).slice(0, 62)}`);
}
console.log(`\n  ${total} card(s) from ${LIVE.length} real utterances`);
