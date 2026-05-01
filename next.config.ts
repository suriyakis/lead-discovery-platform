import type { NextConfig } from 'next';

// Phase 1 baseline. Keep this minimal — add options here only when justified.
//
// `output: 'standalone'` is intentionally NOT set yet. It breaks `next start`,
// and we don't have a Docker production runtime that uses .next/standalone yet.
// Re-enable when the production Dockerfile actually copies the standalone build.
const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
