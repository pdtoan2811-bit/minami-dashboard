// MIND-MAP TEMPLATES — the shape of a meeting you already know how to run.
//
// From a real session: "ý tưởng đầu tiên đấy là sẽ có một số cái template mind map sẵn" and then
// "một cái hệ thống để edit mind map và save mind map đấy thành các template để dễ chọn".
//
// ── Why this is topics and not cards ────────────────────────────────────────────────────────────
// A template is an AGENDA, not content. Anh's own reasoning for wanting them was that in a sharing
// session or a sales call the agenda is clear in advance, and the judge wanders without it —
// "agenda nó khá là rõ… nó cứ pick từ đấy nó đỡ bị lạc". So a template seeds the BACKBONE the judge
// hangs things under, and says nothing about what will be decided.
//
// Storing anything more would be a lie waiting to happen: a template card that says "Pricing agreed"
// is on a shared screen before anyone has spoken.
//
// ── Where they live ────────────────────────────────────────────────────────────────────────────
// ~/.minami/templates/*.json, beside the meetings and the vocabulary. Not in the repo: these are
// anh's own meeting shapes, they change as his work changes, and a git checkout should not be able
// to revert them.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.CANVAS_TEMPLATE_DIR || `${process.env.HOME}/.minami/templates`;

/** Shipped so the picker is never empty on a fresh machine. Written to disk on first read rather
 *  than kept in code, so they are editable the same way a saved one is — a default anh cannot edit
 *  is a default he will work around instead of fixing. */
const SEED = [
  {
    name: "Sharing session",
    topics: ["Vấn đề", "Cách làm", "Demo", "Câu hỏi"],
    note: "A talk: the problem, how it works, a demo, questions.",
  },
  {
    name: "Sales call",
    topics: ["Bối cảnh khách", "Nhu cầu", "Giải pháp", "Giá", "Bước tiếp theo"],
    note: "Discovery through to next steps.",
  },
  {
    name: "Product review",
    topics: ["Đã làm", "Vướng mắc", "Quyết định", "Việc cần làm"],
    note: "What shipped, what is stuck, what we decided, who does what.",
  },
];

const slug = (s) =>
  String(s).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "template";

function ensure() {
  mkdirSync(DIR, { recursive: true });
  // ⚠️ ONLY when the directory is empty. Re-seeding on every read would resurrect a default anh had
  // deliberately deleted, which is the kind of small disobedience that makes a tool untrustworthy.
  if (readdirSync(DIR).some((f) => f.endsWith(".json"))) return;
  for (const t of SEED) {
    try { writeFileSync(join(DIR, `${slug(t.name)}.json`), JSON.stringify(t, null, 2)); } catch { /* read-only home */ }
  }
}

export function listTemplates() {
  try {
    ensure();
    return readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const t = JSON.parse(readFileSync(join(DIR, f), "utf8"));
          if (!t?.name || !Array.isArray(t.topics)) return null;
          return { slug: f.replace(/\.json$/, ""), name: String(t.name), topics: t.topics.map(String).slice(0, 12), note: t.note ? String(t.note) : "" };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function getTemplate(nameOrSlug) {
  const want = slug(nameOrSlug);
  return listTemplates().find((t) => t.slug === want || slug(t.name) === want) ?? null;
}

/** Save the topics currently on a board as a reusable shape.
 *
 *  ⚠️ TOPICS ONLY, and the cards are dropped on purpose. Saving a finished board would carry one
 *  meeting's decisions into the next one — and they would arrive looking exactly like things that
 *  had just been said. The reusable part of a meeting is its shape. */
export function saveTemplate(name, topics, note = "") {
  const clean = [...new Set((topics ?? []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
  if (!name?.trim() || !clean.length) return null;
  ensure();
  const t = { name: name.trim().slice(0, 60), topics: clean, note: String(note).slice(0, 200) };
  const file = join(DIR, `${slug(t.name)}.json`);
  writeFileSync(file, JSON.stringify(t, null, 2));
  return { ...t, slug: slug(t.name) };
}
