/** @type {import('next').NextConfig} */
// Deployed on Vercel (native Next.js runtime) — no static export / basePath needed.
// The Agent SDK spawns the local `claude` CLI and must not be bundled by Next's server build.
const nextConfig = {
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  // Let a second instance use its own build dir so `next dev` (iteration) and `next start` (the stable
  // prod server) can run at the same time without fighting over `.next`. Defaults to `.next`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The knowledge base is plain static HTML in public/kb/, not an app route. Next strips the
  // trailing slash from /kb/ and then has no route to match, so the bare /kb 404s even though
  // /kb/index.html serves fine. Rewrite it so the short, linkable URL works.
  async rewrites() {
    return [{ source: "/kb", destination: "/kb/index.html" }];
  },
  // instrumentation.ts starts Autopilot behind `NEXT_RUNTIME === "nodejs"`. That guard runs at RUNTIME,
  // but webpack resolves imports STATICALLY — and Next compiles instrumentation for the edge runtime
  // too, even with no middleware in the app (verified: the webpack callback fires with
  // nextRuntime="edge"). So the edge pass walked into lib/autopilot/runner.ts and failed on
  // `node:child_process`, then `node:fs`, then the Agent SDK — a new module each time it was patched.
  // `next build` tolerated it; `next dev` returned **500 for every route**, which silently took the
  // whole preview workflow out.
  //
  // Cutting the graph at the ROOT of that subtree rather than naming its leaves: the edge bundle keeps
  // a bare import it never executes. Scoped to edge alone, so the real Node server bundles normally and
  // a stray `node:` import in client code still fails loudly, as it should.
  webpack: (config, { nextRuntime }) => {
    if (nextRuntime === "edge") {
      config.externals = [
        ...(config.externals || []),
        // `var` rather than `module`: the edge target is compiled as a script, and an external of type
        // `module` there fails with "The target environment doesn't support dynamic import() syntax".
        // The reference is never dereferenced on edge — the runtime guard returns first.
        ({ request }, cb) => (request === "@/lib/autopilot/runner" ? cb(null, `var {}`) : cb()),
      ];
    }
    return config;
  },
};
export default nextConfig;
