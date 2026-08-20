// Can a spoken "delete that card" actually be understood? Claimed in a commit; verifying it.
import { readFileSync } from "node:fs";
import { interpretRequest } from "../lib/canvas-llm";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const cfg = { model: "google/gemini-3-flash-preview", strictSchema: true, latencyRouting: true, relateModel: "", tidyModel: "" };
const cards = ["Card giữ lại", "Deploy thứ sáu", "Rủi ro latency tăng"];

for (const line of [
  "Minami xoá cái card Deploy thứ sáu đi",
  "Minami bỏ cái rủi ro latency ra khỏi board",
  "Minami delete the deploy card",
  // control: must NOT delete anything
  "Minami cái card này hay đấy",
]) {
  const r = await interpretRequest(line, { cfg, cards });
  console.log(`  ${line.padEnd(44)} -> ${JSON.stringify(r)}`);
}
