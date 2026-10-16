import { redirect } from "next/navigation";

// /automations merged into /autopilot (§30) — its jobs are the Runners section there, under the goals they serve.
// Kept as a redirect so bookmarks and old links still land on the same list.
export default function AutomationsPage() {
  redirect("/autopilot#runners");
}
