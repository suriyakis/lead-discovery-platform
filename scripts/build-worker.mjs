// PC-36: bundle the background-job worker (src/worker.ts) into one file,
// dist/worker/worker.cjs, for the production image. The image ships only
// the Next.js standalone server, without tsx and without the full
// node_modules, so the worker carries its dependencies with it.
//
//   pnpm build:worker            build (run by docker/Dockerfile after next build)
//   node dist/worker/worker.cjs  run it (ROLE=worker, JOB_QUEUE_PROVIDER=bullmq)
//
// The build fails when the worker's import graph reaches Next.js or
// next-auth: the worker must not depend on request-scoped server code
// (headers, cookies, redirects), and pulling it in usually means a job
// handler imports a page-level module by mistake.

import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist', 'worker', 'worker.cjs');

/** Packages the worker must never bundle (see above). */
const FORBIDDEN = [
  /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?next\//,
  /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?next-auth\//,
];

// pdf-parse 1.1.1 loads its pdf.js build with a template require
// (`./pdf.js/${options.version}/build/pdf.js`), so esbuild bundles all four
// shipped versions (about 11 MB). The app always uses the default version
// (document-extraction.ts and product-autofill.ts pass no options), so pin
// that one. If the pattern ever changes the file is left alone: the bundle
// is then larger, never wrong.
const PDF_PARSE_DYNAMIC_REQUIRE = 'require(`./pdf.js/${options.version}/build/pdf.js`)';
const PDF_PARSE_DEFAULT_VERSION = 'v1.10.100';
const pinPdfParseVersion = {
  name: 'pin-pdf-parse-version',
  setup(b) {
    b.onLoad({ filter: /pdf-parse[\\/]lib[\\/]pdf-parse\.js$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      if (!source.includes(PDF_PARSE_DYNAMIC_REQUIRE)) {
        console.warn('[build-worker] pdf-parse changed; bundling every pdf.js version it ships.');
        return { contents: source, loader: 'js' };
      }
      return {
        contents: source.replace(
          PDF_PARSE_DYNAMIC_REQUIRE,
          `(options.version === '${PDF_PARSE_DEFAULT_VERSION}' ? require('./pdf.js/${PDF_PARSE_DEFAULT_VERSION}/build/pdf.js') : (() => { throw new Error('pdf-parse: only ${PDF_PARSE_DEFAULT_VERSION} is bundled in the worker'); })())`,
        ),
        loader: 'js',
      };
    });
  },
};

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/worker.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  tsconfig: 'tsconfig.json',
  // No source map: the bundle is not minified, so stack traces already
  // name the functions, and the map would double the image layer.
  sourcemap: false,
  // Keep class and function names readable in stack traces and error
  // names (err.name checks such as NonRetryableJobError).
  keepNames: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  plugins: [pinPdfParseVersion],
});

const inputs = Object.keys(result.metafile.inputs);
const forbidden = inputs.filter((p) => FORBIDDEN.some((re) => re.test(p)));
if (forbidden.length > 0) {
  console.error('[build-worker] the worker bundle must not include Next.js / next-auth:');
  for (const p of forbidden.slice(0, 20)) console.error(`  ${p}`);
  process.exit(1);
}

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(
  `[build-worker] ${path.relative(root, outfile)}: ${inputs.length} modules, ${(bytes / 1024 / 1024).toFixed(1)} MB`,
);
