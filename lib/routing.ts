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

// Minami's real recurring jobs, each tagged with the tier the routing skill sends it to, plus a
// typical token footprint so the live meter reflects the shape of real work (not billed spend).
export const WORKLOAD: { label: string; tier: Tier; in: number; out: number }[] = [
  { label: "grep the vault", tier: "Haiku 4.5", in: 4000, out: 300 },
  { label: "check qone status", tier: "Haiku 4.5", in: 3000, out: 200 },
  { label: "run sync.sh", tier: "Haiku 4.5", in: 1500, out: 150 },
  { label: "draft a Slack reply", tier: "Sonnet 5", in: 6000, out: 1200 },
  { label: "reconcile qone → vault", tier: "Sonnet 5", in: 50000, out: 10000 },
  { label: "compact memory", tier: "Sonnet 5", in: 40000, out: 6000 },
  { label: "hold the thread / decide", tier: "Opus 4.8", in: 20000, out: 4000 },
  { label: "final reply anh reads", tier: "Opus 4.8", in: 15000, out: 3000 },
];

export const OPUS_TIER: Tier = "Opus 4.8";

export function tintOf(tier: Tier): string {
  return MODELS.find((m) => m.tier === tier)!.tint;
}

export function costUsd(inTok: number, outTok: number, tier: Tier): number {
  const m = MODELS.find((x) => x.tier === tier)!;
  return (inTok / 1e6) * m.in + (outTok / 1e6) * m.out;
}
