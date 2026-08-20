// Does Minami understand being ASKED, rather than commanded?
//
// Every line here addresses Minami in a way the regex verb table does not match — which is exactly
// the case that used to be silence. The last two are controls: lines that mention Minami but are not
// requests, and must do nothing.

import { readFileSync } from "node:fs";
import { parseCommand, describeCommand, addressesMinami } from "../lib/canvas-commands";
import { interpretRequest } from "../lib/canvas-llm";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const CASES = [
  "Minami làm cho anh một cái card về pricing đi",
  "Minami tạo ra một cái card đặc biệt để anh nói về ý tưởng này",
  "Minami ơi cứu anh với, ghi nhanh cái này lại",
  "Minami create a card about the migration risk",
  "Minami dọn lại cái board cho gọn đi em",
  "Minami bỏ cái vừa rồi đi",
  "Minami chuyển sang nói về pricing nhé",
  "Minami cái này hay đấy, đánh dấu lại đi",
  // controls — must return nothing
  "Minami đang vẽ mind map đấy em thấy không",
  "Cái con Minami này nó chạy trên Google Meet",
];

const cfg = { model: "google/gemini-3-flash-preview", strictSchema: true, latencyRouting: true, relateModel: "", tidyModel: "" };

for (const line of CASES) {
  const regex = parseCommand(line);
  const addressed = addressesMinami(line);
  let semantic: unknown = null;
  if (!regex && addressed) semantic = await interpretRequest(line, { cfg, topics: ["Pricing", "Minami"], cards: ["Deploy thứ sáu"] });
  const before = regex ? `regex: ${describeCommand(regex)}` : addressed ? "regex: MISSED" : "not addressed";
  const after = regex ? "—" : semantic ? JSON.stringify(semantic) : "(nothing)";
  console.log(`  ${line}`);
  console.log(`      ${before.padEnd(28)} → ${after}`);
}
