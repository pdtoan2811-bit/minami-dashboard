/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  basePath: "/minami-dashboard",
  trailingSlash: true,
  images: { unoptimized: true },
};
export default nextConfig;
