// Phase 34: Next.js startup hook. Runs once when the server boots, in
// every container instance. The real work lives in instrumentation-node.ts.
//
// Next.js compiles this file for every runtime, including Edge. The Node-only
// import MUST sit inside an `if (process.env.NEXT_RUNTIME === 'nodejs')`
// block: the bundler replaces NEXT_RUNTIME with a literal per runtime and
// drops the dead branch, so the Edge build never tries to resolve bullmq,
// mailparser or node:stream. An early `return` for non-node runtimes is NOT
// enough — the bundler still follows the imports below it, which is what
// made `next dev` (webpack) fail with "Can't resolve 'stream'".

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeRuntime } = await import('./instrumentation-node');
    await registerNodeRuntime();
  }
}
