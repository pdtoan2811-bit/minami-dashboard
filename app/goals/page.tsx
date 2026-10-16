import { redirect } from "next/navigation";

// /goals merged into /autopilot (§30): a goal and the runners that work on it read as one page now.
// Kept as a redirect so bookmarks, Slack links and the Today plan's old links still land somewhere.
export default function GoalsPage() {
  redirect("/autopilot");
}
