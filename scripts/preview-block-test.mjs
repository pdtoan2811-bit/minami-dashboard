// The preview contract's parser (§5c): the tail ```minami-preview block and the mid-message
// ```minami-preview-ready block. Pure, no server. Run: node scripts/preview-block-test.mjs
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { splitPreviewBlock, splitPreviewSegments, closedReadyBlocks } = await jiti.import(path.join(root, "lib/preview-block.ts"));
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra && !ok ? " — " + extra : ""}`); if (!ok) fails++; };
const J = JSON.stringify;
const kinds = (segs) => segs.map((s) => (s.kind === "text" ? "T" : "R")).join("");
const noJson = (segs) => !segs.some((s) => s.kind === "text" && /minami-preview|"kind"\s*:/.test(s.text));

const ready = J([{ kind: "file", target: "/tmp/a.md", label: "draft" }, { kind: "url", target: "http://localhost:3120/p", label: "pitch" }]);
const tail = J([{ kind: "url", target: "http://localhost:3000", label: "the dashboard" }]);

// (a) tail-only: exactly the old contract, through both entry points.
{
  const msg = `Done, the page is up.\n\n\`\`\`minami-preview\n${tail}\n\`\`\``;
  const old = splitPreviewBlock(msg);
  check("(a) tail-only: old parser body + chip", old.body === "Done, the page is up." && old.previews.length === 1 && old.previews[0].label === "the dashboard");
  const s = splitPreviewSegments(msg);
  check("(a) tail-only: one text segment, same tail chips", kinds(s.segments) === "T" && s.segments[0].text === old.body && J(s.previews) === J(old.previews));
  check("(a) tail-only: nothing for the server to announce", closedReadyBlocks(msg).length === 0);
}

// (b) one ready-block mid-message, then more prose, then the tail.
{
  const msg = `Rendering the pitch.\n\n\`\`\`minami-preview-ready\n${ready}\n\`\`\`\n\nNow tightening the copy.\n\n\`\`\`minami-preview\n${tail}\n\`\`\``;
  const s = splitPreviewSegments(msg);
  check("(b) mid ready + tail: T R T in order", kinds(s.segments) === "TRT", kinds(s.segments));
  check("(b) ready row: localhost sorted first", s.segments[1]?.previews?.[0]?.target === "http://localhost:3120/p" && s.segments[1].previews.length === 2);
  check("(b) prose either side intact", s.segments[0].text === "Rendering the pitch." && s.segments[2].text === "Now tightening the copy.");
  check("(b) tail chips still parse", s.previews.length === 1 && s.previews[0].target === "http://localhost:3000");
  check("(b) no raw JSON in prose", noJson(s.segments));
  const c = closedReadyBlocks(msg);
  check("(b) server sees one closed block with a stable key", c.length === 1 && c[0].key === ready && c[0].previews[0].label === "pitch");
  // A ready-block as the very LAST thing (no tail) must still be a ready row, not a broken tail block.
  const end = splitPreviewSegments(`Look now.\n\`\`\`minami-preview-ready\n${ready}\n\`\`\``);
  check("(b) ready-block at the end: still a ready row", kinds(end.segments) === "TR" && end.previews.length === 0);
}

// (c) an unclosed ready-block mid-stream: hidden from the fence on, never flashed, never announced.
{
  const msg = `Rendering the pitch.\n\n\`\`\`minami-preview-ready\n[{"kind":"url","target":"http://local`;
  const s = splitPreviewSegments(msg);
  check("(c) unclosed: only the prose before it", kinds(s.segments) === "T" && s.segments[0].text === "Rendering the pitch.");
  check("(c) unclosed: no raw JSON", noJson(s.segments));
  check("(c) unclosed: server announces nothing", closedReadyBlocks(msg).length === 0);
  const pre = splitPreviewSegments("Rendering the pitch.\n\n```minami-preview-rea");
  check("(c) fence half-typed: hidden too", kinds(pre.segments) === "T" && pre.segments[0].text === "Rendering the pitch.");
}

// (d) invalid JSON: the block disappears, the prose around it stays, nothing announced.
{
  const msg = `Before.\n\`\`\`minami-preview-ready\n[{"kind":"url",, oops\n\`\`\`\nAfter.`;
  const s = splitPreviewSegments(msg);
  check("(d) invalid JSON: hidden, prose kept", kinds(s.segments) === "TT" && s.segments[0].text === "Before." && s.segments[1].text === "After.");
  check("(d) invalid JSON: no raw JSON", noJson(s.segments));
  check("(d) invalid JSON: server announces nothing", closedReadyBlocks(msg).length === 0);
}

// (e) prose that merely MENTIONS the fence inline is not a block.
{
  const msg = "Write a ```minami-preview-ready block when it's viewable.";
  const s = splitPreviewSegments(msg);
  check("(e) inline mention left alone", kinds(s.segments) === "T" && s.segments[0].text === msg);
}

console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
