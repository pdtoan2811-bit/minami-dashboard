import localFont from "next/font/local";

// The Today page borrows ecvision's onboarding look (§26), and that look is set in Inter + JetBrains
// Mono (the kit's --k-font-sans / --k-font-mono). Since §30 the root layout loads them for every page:
// the shell gives the whole app this material, so the font stopped being a Today-only choice.
//
// Local files, not next/font/google: a page's font must never make a deploy of the live dashboard
// depend on the network. `next build` replaces .next under the running server, so a failed Google
// Fonts fetch could leave nothing serving. The woff2 files are @fontsource-variable 5.x (OFL).
//
// Vietnamese is its own face: without unicode-range, faces of one family don't combine (the last wins),
// so the page chains var(--today-sans), var(--today-sans-vi). No size-adjusted fallback on the latin
// face, or that fallback (local Arial, every code point) would draw Vietnamese before the vi face.
export const inter = localFont({ src: "./fonts/inter-latin-wght-normal.woff2", variable: "--today-sans", display: "swap", weight: "100 900", adjustFontFallback: false });
export const interVi = localFont({ src: "./fonts/inter-vietnamese-wght-normal.woff2", variable: "--today-sans-vi", display: "swap", weight: "100 900", adjustFontFallback: false });
export const mono = localFont({ src: "./fonts/jetbrains-mono-latin-wght-normal.woff2", variable: "--today-mono", display: "swap", weight: "100 800" });
