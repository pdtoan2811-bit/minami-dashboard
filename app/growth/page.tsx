import type { Metadata } from "next";
import { Growth } from "./Growth";

// Growth (§35): traffic → signup → paid by traffic source, from PostHog, daily. Pitch posthog-growth F2.
export const metadata: Metadata = { title: "Minami — growth" };

export default function GrowthPage() {
  return <Growth />;
}
