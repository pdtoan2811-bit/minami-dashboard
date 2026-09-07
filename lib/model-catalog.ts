// Every model a picker in this app may offer.
//
// A leaf module with no imports, on purpose. The rule in CLAUDE.md is that model ids live in
// lib/model-pins.ts and nowhere else, so that the model a session runs on and the model the dashboard
// *alerts on* can't drift apart — but model-pins.ts reads ~/Minami's config off disk, so a browser
// component can't import it. Splitting the list out (and re-exporting it from model-pins) keeps one
// list of ids while letting both sides read it.
//
// Tiers and notes, not bare ids: the question actually being asked at an agent's model picker is
// "what's the cheapest thing that will still get this right". The model-routing skill is the long
// answer; this is the version that fits in a dropdown.
export const SELECTABLE_MODELS: { id: string; label: string; note: string; premium?: boolean }[] = [
  { id: "claude-opus-5", label: "Opus 5", note: "Top tier. Judgement, ambiguity, code that has to be right." },
  { id: "claude-sonnet-5", label: "Sonnet 5", note: "Fast and capable. The right default for high-volume work." },
  { id: "claude-fable-5-1", label: "Fable 5.1", note: "Frontier. Long-horizon agents; when Opus falls short. 2× Opus price.", premium: true },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "Cheapest. Mechanical passes, scans, summaries." },
];

// The model every spawner on this box is expected to be on, as a LITERAL — deliberately not derived
// from anything overridable. lib/model-pins.ts's PINNED_MODEL is env-overridable by design, so a drift
// check written as `DASHBOARD_MODEL !== PINNED_MODEL` compares the config against itself: point
// MINAMI_PINNED_MODEL at Fable and the check moves with it and reports green. This constant is the
// fixed point that makes "did the pin itself move?" an answerable question. Change it only when the
// box's declared default genuinely changes.
export const EXPECTED_MODEL = "claude-opus-5";

/** Is this an id the app is willing to send? Anything else is a stale or hand-edited value. */
export function isSelectableModel(id?: string | null): boolean {
  return !!id && SELECTABLE_MODELS.some((m) => m.id === id);
}

/**
 * Fable, by family rather than by exact id — the alert has to survive a version bump. It fires on
 * `claude-fable-5`, `claude-fable-5-1` and whatever comes next, including ids that fell off the
 * catalog (which is exactly the case that burned a session at 2× price on 2026-09-03: the catalog
 * moved to 5.1, a stored `claude-fable-5` kept being sent, and every surface called it "default").
 */
export function isPremiumModel(id?: string | null): boolean {
  return !!id && /fable/i.test(id);
}

// Context window per model family, for the composer's context meter. Coarse on purpose — the meter
// answers "how close is this chat to compaction", not billing. 200k for Haiku 4.5; every current
// larger model is 1M (docs checked 2026-09-02). New families default to 1M: over-stating the window
// under-states the fill, and the meter turning amber late beats a false alarm on day one.
export function contextWindowFor(model?: string | null): number {
  return model?.includes("haiku") ? 200_000 : 1_000_000;
}
