import { NextResponse } from "next/server";
import { getGrowth } from "@/lib/growth";

// §35. GET = today's cached pull (pulls first if the cache is from an earlier day); POST = pull now.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getGrowth());
}

export async function POST() {
  return NextResponse.json(await getGrowth(true));
}
