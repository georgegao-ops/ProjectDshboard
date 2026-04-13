// @ts-check
import withNx from "@nx/next/plugins/with-nx.js";

/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@contractor/shared"],
  swcMinify: true,
  experimental: {
    optimizePackageImports: ["@contractor/shared"],
  },
};

export default withNx(nextConfig);
