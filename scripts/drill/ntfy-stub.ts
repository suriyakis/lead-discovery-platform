/* eslint-disable no-console */
/**
 * scripts/drill/ntfy-stub.ts — a local stand-in for the ntfy server the
 * owner alerts go to (PC-08, src/lib/ops/alert-config.ts), for the Phase 1
 * drill. Point NTFY_URL at it (NTFY_URL=http://127.0.0.1:2580,
 * NTFY_TOPIC=<anything>) and every alert the watchdog sends is recorded
 * here instead of reaching a phone. Loopback only; nothing is forwarded.
 *
 *   pnpm exec tsx scripts/drill/ntfy-stub.ts        (NTFY_STUB_PORT, default 2580)
 *
 *   GET  /__requests   every request so far: method, path, title, priority,
 *                      tags and the first 2 KB of the body
 *   POST /__reset      forget them
 *   anything else      recorded, answered 200 like ntfy does
 */

import http from 'node:http';

export interface NtfyRequest {
  at: string;
  method: string;
  path: string;
  title: string | null;
  priority: string | null;
  tags: string | null;
  body: string;
}

export interface NtfyStub {
  readonly port: number;
  requests(): NtfyRequest[];
  reset(): void;
  close(): Promise<void>;
}

const BODY_KEEP = 2048;

function header(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export async function startNtfyStub(port = 2580, host = '127.0.0.1'): Promise<NtfyStub> {
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('ntfy-stub binds loopback only');
  let log: NtfyRequest[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://ntfy.local');
    if (req.method === 'GET' && url.pathname === '/__requests') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(log));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__reset') {
      log = [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= BODY_KEEP) chunks.push(c);
    });
    req.on('end', () => {
      log.push({
        at: new Date().toISOString(),
        method: req.method ?? 'GET',
        path: url.pathname,
        title: header(req, 'title') ?? header(req, 'x-title'),
        priority: header(req, 'priority') ?? header(req, 'x-priority'),
        tags: header(req, 'tags') ?? header(req, 'x-tags'),
        body: Buffer.concat(chunks).toString('utf8').slice(0, BODY_KEEP),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `drill${log.length}`, event: 'message' }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return {
    port,
    requests: () => log.slice(),
    reset: () => {
      log = [];
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const isMain = /ntfy-stub\.(ts|js|cjs|mjs)$/.test(process.argv[1] ?? '');

if (isMain) {
  const port = Number(process.env.NTFY_STUB_PORT ?? 2580);
  startNtfyStub(port)
    .then((stub) => {
      console.log(`[ntfy-stub] recording on http://127.0.0.1:${stub.port} (GET /__requests)`);
      const stop = () => void stub.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err: unknown) => {
      console.error('[ntfy-stub] failed to start:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
