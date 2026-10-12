import type { MetadataRoute } from "next";

// Makes "Add to Home screen" on a phone install the dashboard as an app rather than drop a bookmark:
// `standalone` drops Chrome's address bar, which on a 6-inch screen is ~56px of every chat handed back
// to the transcript, and the app gets its own task-switcher entry instead of hiding among browser tabs.
// Installing needs a secure origin, which on this box means the tailnet's `tailscale serve` URL
// (docs/knowledge/23-mobile.md §23) — a plain http://<lan-ip>:3000 still works, just as a tab.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Minami Bento",
    short_name: "Minami",
    description: "Claude Code mission control",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    // Long-press the home-screen icon → Meet. An in-room meeting starts with the phone already in
    // hand, so the mic page should be one gesture away rather than three taps through the inbox.
    shortcuts: [{ name: "Meet — listen in the room", short_name: "Meet", url: "/meet" }],
    icons: [
      { src: "/app-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/app-icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
