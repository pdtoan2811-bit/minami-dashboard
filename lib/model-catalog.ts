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
export const SELECTABLE_MODELS: { id: string; label: string; note: string }[] = [
  { id: "claude-opus-5", label: "Opus 5", note: "Top tier. Judgement, ambiguity, code that has to be right." },
  { id: "claude-sonnet-5", label: "Sonnet 5", note: "Fast and capable. The right default for high-volume work." },
  { id: "claude-fable-5", label: "Fable 5", note: "Writing-leaning." },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "Cheapest. Mechanical passes, scans, summaries." },
];
