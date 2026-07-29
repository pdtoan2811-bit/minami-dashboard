// Claude model-routing reference (prices per million tokens, Claude API, verified 2026-07-29).
// The idea: spend the least while keeping output quality identical — push grunt work (search,
// reads, status checks) down to cheaper tiers and reserve the top tier for judgement. Edit this
// table to match the models and prices you actually use.
//
// NOTE: Sonnet 5 is listed at its INTRODUCTORY price ($2/$10). That runs through 2026-08-31;
// from 2026-09-01 the standard rate is $3/$15 — bump the row then or the savings bar under-reports
// what Sonnet turns actually cost.

export type Tier = "Haiku 4.5" | "Sonnet 5" | "Opus 5" | "Opus 4.8" | "Fable 5";

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
  { tier: "Opus 5", id: "claude-opus-5", in: 5, out: 25, tint: "#b98cff", note: "judgement · default" },
  // Same $5/$25 as Opus 5 — kept so historical events still tier + price correctly.
  { tier: "Opus 4.8", id: "claude-opus-4-8", in: 5, out: 25, tint: "#8f7ab8", note: "legacy · pre-2026-07-29" },
  { tier: "Fable 5", id: "claude-fable-5", in: 10, out: 50, tint: "#f0a868", note: "hardest reasoning only" },
];

export const ROUTING_RULES: { work: string; tier: Tier; why: string }[] = [
  { work: "grep / glob, read logs, fetch one number, check a status", tier: "Haiku 4.5", why: "finding ≠ thinking — 5× cheaper than Opus" },
  { work: "summarise, draft a reply, build a task, light review", tier: "Sonnet 5", why: "near-Opus quality, ~2.5× cheaper" },
  { work: "decide, complex code, final synthesis, anything a human reads", tier: "Opus 5", why: "judgement work — don't downgrade" },
  { work: "very long autonomous run, hardest reasoning", tier: "Fable 5", why: "only when Opus visibly struggles — 2× Opus" },
];

// Resolve a real model id (e.g. "claude-sonnet-5") to its tier/price/tint. Unknown ids fall back to
// the top default tier, so an unrecognised model is over-costed rather than silently under-costed.
export function tierFromModel(model?: string) {
  return MODELS.find((m) => (model || "").includes(m.id)) || MODELS.find((m) => m.tier === "Opus 5")!;
}

// Actual cost of a real turn, given its token counts + model (cache reads billed at 0.1x input).
export function eventCost(inTok = 0, outTok = 0, cacheTok = 0, model?: string): number {
  const m = tierFromModel(model);
  return ((inTok + cacheTok * 0.1) / 1e6) * m.in + (outTok / 1e6) * m.out;
}

// What the same turn WOULD have cost on Opus — the baseline the routing saving is measured against.
// Opus 5 and Opus 4.8 are both $5/$25, so this swap doesn't move any historical number.
const OPUS = MODELS.find((m) => m.tier === "Opus 5")!;
export function opusEquivCost(inTok = 0, outTok = 0, cacheTok = 0): number {
  return ((inTok + cacheTok * 0.1) / 1e6) * OPUS.in + (outTok / 1e6) * OPUS.out;
}
