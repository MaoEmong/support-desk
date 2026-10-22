import type { NextConfig } from 'next';
const config: NextConfig = {
  transpilePackages: ['@support/db', '@support/contracts', '@support/queue', '@support/ai'],
  webpack(webpackConfig) {
    // Workspace packages use Node ESM .js specifiers for TypeScript sources.
    webpackConfig.resolve ??= {};
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return webpackConfig;
  },
};
export default config;
