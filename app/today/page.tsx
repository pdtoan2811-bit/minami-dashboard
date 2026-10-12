import type { Metadata } from "next";
import { Today } from "./Today";

// The morning page (§26): the heartbeat's plan for the two focus areas, the to-dos, and the open
// questions only Thomas can answer. Opens itself at login and at 09:00 (launchd, see bin/minami-open.sh).
export const metadata: Metadata = { title: "Minami — today" };

export default function TodayPage() {
  return <Today />;
}
