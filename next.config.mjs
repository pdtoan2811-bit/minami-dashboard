/** @type {import('next').NextConfig} */
// Deployed on Vercel (native Next.js runtime) — no static export / basePath needed.
// The Agent SDK spawns the local `claude` CLI and must not be bundled by Next's server build.
const nextConfig = {
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  // Let a second instance use its own build dir so `next dev` (iteration) and `next start` (the stable
  // prod server) can run at the same time without fighting over `.next`. Defaults to `.next`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};
export default nextConfig;
