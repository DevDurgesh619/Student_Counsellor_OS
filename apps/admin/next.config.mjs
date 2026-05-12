/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@wgc/shared'],
  webpack: (config) => {
    // Workspace packages author imports with explicit `.js` extensions for
    // Node ESM compatibility, but the source files are `.ts`. Tell webpack to
    // try `.ts`/`.tsx` when a `.js` import doesn't resolve.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
