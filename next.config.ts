import type { NextConfig } from 'next';

// Phase 1 baseline. Keep this minimal — add options here only when justified.
//
// `output: 'standalone'` is required by the production Dockerfile (multi-stage
// build copies .next/standalone). For local dev use `pnpm dev` (which doesn't
// use the standalone build); `next start` will warn and not work as expected
// when this is set — that's intentional.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
};

export default nextConfig;
