import type { Metadata } from "next";
import { Glance } from "./Glance";

// The cover-screen view (§23): what a Galaxy Z Flip 7's Flex Window can usefully show at arm's length.
// A server shell only so the route can carry its own title; everything live is in the client half.
export const metadata: Metadata = { title: "Minami — glance" };

export default function GlancePage() {
  return <Glance />;
}
