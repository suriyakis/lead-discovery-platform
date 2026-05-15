import type { NextConfig } from 'next';

// Phase 1 baseline. Keep this minimal — add options here only when justified.
//
// `output: 'standalone'` is required by the production Dockerfile (multi-stage
// build copies .next/standalone). For local dev use `pnpm dev` (which doesn't
// use the standalone build); `next start` will warn and not work as expected
// when this is set — that's intentional.
//
// Phase 50: server actions bodySizeLimit raised from Next's 1 MB default to
// 32 MB so document + knowledge-source upload forms can carry PDFs / DOCX
// inline. Meaningful gating is the per-product cap
// (workspaces.vector_storage_quota_mb_per_product, default 20 MB) — this
// just needs to be a bit larger so the framework doesn't refuse uploads
// the operator workflow allows.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  experimental: {
    serverActions: {
      bodySizeLimit: '32mb',
    },
  },
};

export default nextConfig;
