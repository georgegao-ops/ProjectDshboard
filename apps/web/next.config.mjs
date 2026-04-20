// @ts-check

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

export default nextConfig;
