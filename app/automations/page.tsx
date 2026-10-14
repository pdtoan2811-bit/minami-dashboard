import type { Metadata } from "next";
import { Automations } from "./Automations";

// Every job that runs on this Mac without being asked — launchd jobs and the loops inside the Minami bot —
// with run · pause · edit · delete (§27).
export const metadata: Metadata = { title: "Minami — automations" };

export default function AutomationsPage() {
  return <Automations />;
}
