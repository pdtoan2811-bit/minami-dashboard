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
    // `dark` is set here, not left to the OS. The app was only ever half dual-theme: the bento board
    // and /settings force dark with `.bg-bento`, while /dashboard's cards were the only surface with
    // `dark:` variants — so on a machine preferring light, /dashboard rendered light while everything
    // one click away rendered dark, and Nav (hardcoded `border-white/10`) was nearly invisible on it.
    // Committing to one theme is what lets the `dark:` branches below and in the panels go away.
    <html lang="en" className="dark">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
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
