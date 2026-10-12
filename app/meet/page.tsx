import type { Metadata } from "next";
import { Meet } from "./Meet";

// The phone as Minami's ear (§17b): in-room meetings with no call to join. The mic streams into the
// same canvas pipeline a Recall bot feeds, and the page's job is as much "prove it is working" as
// "show the board" — see the health strip in Meet.tsx.
export const metadata: Metadata = { title: "Minami — meet" };

export default function MeetPage() {
  return <Meet />;
}
