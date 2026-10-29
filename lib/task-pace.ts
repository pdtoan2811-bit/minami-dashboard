// How a task runs (§37, "pace"). Thomas, 2026-10-28: some tasks should go through every to-do in one go
// without a click per item, others need him — UI/UX work he wants pitched as versions first, and anything
// that leaves the machine. "Make it rare for me to actually need input."
//
// So every done-item carries a gate, decided semantically by Haiku when the list is written (or later for
// items added by hand or by the chat), and tappable on the card:
//   null    — the chat does it and moves on (the default; most items)
//   "pitch" — how something LOOKS or how a person USES it: show versions, wait for his pick
//   "ok"    — leaves the machine or can't be undone: get it ready, then ask before doing it
//   undefined — not classified yet; treated as null so a slow Haiku never holds a run up
// A run is "every open item up to the first gate". This file is pure (no node imports): the card, the
// task_status text and the server's auto-continue all read the same plan.
import type { FlowDod } from "@/lib/flow-store";

export type Gate = "pitch" | "ok";
export const GATE_LABEL: Record<Gate, string> = { pitch: "your pick", ok: "asks you" };
export const GATE_HOW: Record<Gate, string> = {
  // "Show them" used to be read as "put the URL in the text", and the chat then asked at once. A URL in prose
  // opens nothing for him, and the turn's closing preview block never comes while a question card is up, so
  // he was asked to pick versions he had not seen (2026-10-29). The ready block is what puts it on his screen.
  pitch: "pitch it first — build 2–4 genuinely different versions (the pitch skill). Then write the pitch URL in a `minami-preview-ready` block BEFORE you ask; a URL in prose shows him nothing. Only then ask Thomas to pick with AskUserQuestion. Stop there; the pick is his",
  ok: "get everything ready, then ask Thomas before doing it (AskUserQuestion) — it leaves the machine or can't be undone. Stop there",
};

export type RunPlan = {
  /** Open items the chat can do now, in order, before the first gate. */
  run: { n: number; d: FlowDod }[];
  /** The first open gated item, where a run stops for him. */
  stop?: { n: number; d: FlowDod; gate: Gate };
  open: number;
};

export function runPlan(dod: FlowDod[] = []): RunPlan {
  const run: RunPlan["run"] = [];
  let stop: RunPlan["stop"];
  let open = 0;
  dod.forEach((d, i) => {
    if (d.done) return;
    open++;
    if (stop) return;
    if (d.gate) stop = { n: i + 1, d, gate: d.gate };
    else run.push({ n: i + 1, d });
  });
  return { run, stop, open };
}

/** One line for the card: how far it goes on its own. */
export function paceLine(dod: FlowDod[] = []): string | null {
  const p = runPlan(dod);
  if (!p.open) return null;
  if (!p.stop) return p.open > 1 ? "Runs A→Z on its own" : "Runs on its own";
  const gate = GATE_LABEL[p.stop.gate];
  return p.run.length ? `Runs ${p.run.length} on its own, then ${gate}` : `Waits on ${gate} first`;
}

/** What ▶ Run sends to the task's chat: every item up to the first gate, in one go. */
export function runMessage(title: string, dod: FlowDod[] = []): string | null {
  const p = runPlan(dod);
  if (!p.run.length && !p.stop) return null;
  const lines = [`Run the done-list for "${title}".`];
  if (p.run.length) lines.push(`Do these in order, all in one go — don't stop to ask between them, and report each with task_report as it's met:\n${p.run.map((x) => `${x.n}. ${x.d.t}`).join("\n")}`);
  if (p.stop) lines.push(`${p.run.length ? "Then" : "First"} item ${p.stop.n}, "${p.stop.d.t}": ${GATE_HOW[p.stop.gate]}.`);
  else lines.push("Nothing on the list needs Thomas. If something truly blocks you, say what and stop; don't guess past it.");
  return lines.join("\n\n");
}

/** The "how to run it" part of task_status, so a chat started from a typed prompt runs the same way. */
export function runRules(dod: FlowDod[] = []): string {
  const p = runPlan(dod);
  if (!p.open) return "";
  const gated = dod.map((d, i) => ({ d, n: i + 1 })).filter((x) => !x.d.done && x.d.gate);
  return [
    "How to run it: work through the open items in order in one go, without stopping to ask between them. Thomas wants to be asked rarely.",
    gated.length
      ? `Stop only at: ${gated.map((x) => `item ${x.n} (${GATE_HOW[x.d.gate!]})`).join("; ")}.`
      : "No item needs Thomas — do all of it. If something truly blocks you, say what and stop.",
  ].join("\n");
}

/** A done-item about shipping the work rather than making it. */
export const SHIP_ITEM = /merg|deploy|live|ship|publish|release|push/i;

/** Next in Thomas's tap cycle on an item's gate chip: auto → your pick → asks you → auto. A ship item
 *  skips "your pick": there are no versions of a merge to choose between. On 2026-10-29 four "Merged and
 *  deployed" items sat on "your pick" from one tap each, every task read Waiting, and the chats stopped
 *  short of merges that had in fact already happened — he wanted merges to run on their own. */
export const nextGate = (g?: Gate | null, ship = false): Gate | null =>
  ship ? (g ? null : "ok") : !g ? "pitch" : g === "pitch" ? "ok" : null;

/** A gate an item may hold: "pitch" on a ship item is read as none (see nextGate). */
export const gateFor = (t: string, g: Gate | null): Gate | null => (g === "pitch" && SHIP_ITEM.test(t) ? null : g);

/** The rules Haiku classifies by, shared by the done-list writer and the late classifier. */
export const GATE_RULES = `For each item decide its gate:
- "pitch": deciding how something LOOKS or how a person USES it — a new screen, layout, visual style, flow, a widget whose look isn't settled yet, marketing visuals. Thomas wants versions to pick from before it's built. NOT a bug fix in existing UI, wiring in a design he already picked, or a control whose look is already decided.
- "ok": leaves the machine or can't be undone — publishing, posting, sending a message or email to people, spending money (paid APIs, image generation), deleting data, pushing to a shared production system customers see. NOT local commits, builds, tests, merges into his own tools, or deploying his own dashboard.
- Merging or deploying is never "pitch": there is nothing to pick between.
- null: everything else — the chat just does it. Most items are null. When unsure, null: Thomas wants to be asked rarely.`;

export function parseGate(x: unknown): Gate | null {
  return x === "pitch" || x === "ok" ? x : null;
}
