import { harnessState } from "@/lib/harness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → the harness browser's status, open tabs, login page and usage log (§36).
export async function GET() {
  return Response.json(await harnessState());
}
