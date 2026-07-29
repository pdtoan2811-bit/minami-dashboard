import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AccountAlert } from "@/components/AccountAlert";

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
            nothing at all unless the live identity is actually off the preferred account. */}
        <AccountAlert />
        {children}
      </body>
    </html>
  );
}
