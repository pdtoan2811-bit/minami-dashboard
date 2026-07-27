// Model-routing data — mirrors the vault `model-routing` skill (prices verified 2026-07-24,
// Claude API, per million tokens). Minami itself runs on Opus 4.8 at --effort high; grunt work
// is pushed down to cheaper tiers. This is REAL config; the live stream below is a sample workload.

export type Tier = "Haiku 4.5" | "Sonnet 5" | "Opus 4.8" | "Fable 5";

export const MODELS: {
  tier: Tier;
  id: string;
  in: number;
  out: number;
  tint: string;
  note: string;
}[] = [
  { tier: "Haiku 4.5", id: "claude-haiku-4-5", in: 1, out: 5, tint: "#6cc4a1", note: "search & grunt" },
  { tier: "Sonnet 5", id: "claude-sonnet-5", in: 2, out: 10, tint: "#e8859b", note: "draft & reconcile" },
  { tier: "Opus 4.8", id: "claude-opus-4-8", in: 5, out: 25, tint: "#b98cff", note: "judgement · Minami self" },
  { tier: "Fable 5", id: "claude-fable-5", in: 10, out: 50, tint: "#f0a868", note: "only when Opus struggles" },
];

export const ROUTING_RULES: { work: string; tier: Tier; why: string }[] = [
  { work: "grep / glob, read logs, run sync.sh, fetch one number, check a status", tier: "Haiku 4.5", why: "finding ≠ thinking — 5× cheaper than Opus" },
  { work: "summarise notes, draft a Slack/qone reply, build a task, light review", tier: "Sonnet 5", why: "near-Opus quality, ~2.5× cheaper" },
  { work: "hold the thread, decide, complex code, final synthesis, anything anh reads", tier: "Opus 4.8", why: "judgement work — don't downgrade" },
  { work: "very long autonomous run, hardest reasoning", tier: "Fable 5", why: "only when Opus visibly struggles — 2× Opus" },
];

// Resolve a real model id (e.g. "claude-sonnet-5") to its tier/price/tint. Defaults to Opus.
export function tierFromModel(model?: string) {
  return MODELS.find((m) => (model || "").includes(m.id)) || MODELS.find((m) => m.tier === "Opus 4.8")!;
}

// Actual cost of a real turn, given its token counts + model (cache reads billed at 0.1x input).
export function eventCost(inTok = 0, outTok = 0, cacheTok = 0, model?: string): number {
  const m = tierFromModel(model);
  return ((inTok + cacheTok * 0.1) / 1e6) * m.in + (outTok / 1e6) * m.out;
}

// What the same turn WOULD have cost on Opus — the baseline the routing saving is measured against.
const OPUS = MODELS.find((m) => m.tier === "Opus 4.8")!;
export function opusEquivCost(inTok = 0, outTok = 0, cacheTok = 0): number {
  return ((inTok + cacheTok * 0.1) / 1e6) * OPUS.in + (outTok / 1e6) * OPUS.out;
}
