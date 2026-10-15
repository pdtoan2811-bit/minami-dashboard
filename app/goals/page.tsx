import type { Metadata } from "next";
import { Goals } from "./Goals";

// Every autonomous goal the goal runner works on each morning — where it stands against its deadline, what the
// runner did, and Thomas's part today (§29).
export const metadata: Metadata = { title: "Minami — goals" };

export default function GoalsPage() {
  return <Goals />;
}
