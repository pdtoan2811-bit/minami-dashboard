"use client";
// Crew (§30): the roster and the teams on one page.
//
// They were two top-level tabs, /agents and /teams, but a team is agents with a template — its roles
// ARE roster agents, the same brains — so two tabs over-split one idea and sent you between them to
// answer "who's working on what". Roster first (who), products below (what they're building). Each half
// owns its own poll and dialogs, so the page is only composition.
//
// The nav shows Crew only when Settings → agent mode is on; the page itself doesn't check, same as
// /agents and /teams never did, so a typed URL or an old bookmark still works.
import Roster from "@/components/agents/Roster";
import Products from "@/components/teams/Products";
import { Ground, TopBar } from "@/app/today/ui";

export default function CrewPage() {
  return (
    <Ground>
      <TopBar title="Crew" />
      {/* pb-28 on phones clears the shell's fixed bottom bar (~64px) with room to spare. */}
      <main className="mx-auto max-w-6xl space-y-10 px-5 pb-28 sm:px-11 sm:pb-16">
        <Roster />
        <Products />
      </main>
    </Ground>
  );
}
