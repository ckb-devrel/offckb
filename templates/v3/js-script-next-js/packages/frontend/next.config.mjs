/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    optimizePackageImports: ["@ckb-ccc/core", "@ckb-ccc/core/bundle"],
  },
  webpack(config) {
    config.resolve.fallback = {
      ...config.resolve.fallback,

      fs: false, // simple workaround for the lumos.hd.keystore fs not found problem
    };

    return config;
  },
};

export default nextConfig;
