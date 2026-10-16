import type { Metadata } from "next";
import { Autopilot } from "./Autopilot";

// Goals and the jobs that work on them, on one page (§30; the parts are §29 goals and §27 automations).
export const metadata: Metadata = { title: "Autopilot" };

export default function AutopilotPage() {
  return <Autopilot />;
}
