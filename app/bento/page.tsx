import { redirect } from "next/navigation";
// Bento is the homepage now.
export default function BentoRedirect() {
  redirect("/");
}
