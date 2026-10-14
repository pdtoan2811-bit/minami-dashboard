import type { Metadata } from "next";
import { Ideas } from "./Ideas";

// Ideas (§28): what Thomas stashed by DMing Minami — sorted by day, by hot/cold and by theme.
export const metadata: Metadata = { title: "Minami — ideas" };

export default function IdeasPage() {
  return <Ideas />;
}
