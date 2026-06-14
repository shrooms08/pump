/** @type {import('next').NextConfig} */
const nextConfig = {
  // @pump/shared ships raw TS; let Next compile it.
  transpilePackages: ["@pump/shared"],
  webpack: (config) => {
    // The shared package uses explicit .js specifiers on its TS source
    // (ESM convention); teach webpack to resolve them to the .ts files.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
