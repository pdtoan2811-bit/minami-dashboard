import type { Metadata } from "next";
import { Harness } from "./Harness";

// The harness browser (§36): is it up, is it logged in, and what has it been used for.
export const metadata: Metadata = { title: "Minami — harness browser" };

export default function HarnessPage() {
  return <Harness />;
}
