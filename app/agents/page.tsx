// /agents folded into /crew (§30) — kept as a redirect so bookmarks and old links still land.
import { redirect } from "next/navigation";

export default function AgentsPage() {
  redirect("/crew");
}
