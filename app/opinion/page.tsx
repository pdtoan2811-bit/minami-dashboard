import type { Metadata } from "next";
import { Opinion } from "./Opinion";

// Opinion Reveal (§38): the weekly interview for Video Studio's opinion video, answered as a chat.
export const metadata: Metadata = { title: "Minami — opinion reveal" };

export default function OpinionPage() {
  return <Opinion />;
}
