import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AccountStatus } from "@/components/AccountStatus";

export const metadata: Metadata = {
  title: "Minami Bento — Claude Code mission control",
  description: "Every Claude Code session on your machine as a live bento tile, plus real-time cross-machine usage & model-routing metrics.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#e8859b",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        {/* Global, not per-page: falling off the preferred account matters wherever you happen to
            be in the app (Bento, /dashboard, /settings), so it lives in the root layout. Renders
            nothing while healthy — it only appears when you're on a fallback account (card, then a
            persistent dot once collapsed) or for a few seconds after recovering. */}
        <AccountStatus />
        {children}
      </body>
    </html>
  );
}
