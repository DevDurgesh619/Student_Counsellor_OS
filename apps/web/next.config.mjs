/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@wgc/shared'],
  webpack: (config) => {
    // Workspace packages use explicit `.js` ESM imports; tell webpack to try
    // `.ts` when those don't resolve. Mirror of apps/admin/next.config.mjs.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
