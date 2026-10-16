// /teams folded into /crew (§30); the hash lands on the teams half rather than the roster above it.
import { redirect } from "next/navigation";

export default function TeamsPage() {
  redirect("/crew#teams");
}
