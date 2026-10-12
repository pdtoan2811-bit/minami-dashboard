import { Inter, JetBrains_Mono } from "next/font/google";

// The Today page borrows ecvision's onboarding look (§26), and that look is set in Inter + JetBrains
// Mono (the kit's --k-font-sans / --k-font-mono). Scoped to this route so the rest of the dashboard
// keeps its system stack.
export const inter = Inter({ subsets: ["latin", "vietnamese"], variable: "--today-sans", display: "swap" });
export const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--today-mono", display: "swap" });
