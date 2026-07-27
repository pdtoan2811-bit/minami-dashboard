/** @type {import('next').NextConfig} */
// Deployed on Vercel (native Next.js runtime) — no static export / basePath needed.
// The Agent SDK spawns the local `claude` CLI and must not be bundled by Next's server build.
const nextConfig = {
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
};
export default nextConfig;
