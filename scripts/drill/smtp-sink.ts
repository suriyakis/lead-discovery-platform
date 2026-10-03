/* eslint-disable no-console */
/**
 * scripts/drill/smtp-sink.ts — the local SMTP sink of the Phase 1 drill
 * (docs/drills/phase1-drill.md, scripts/drill/phase1-drill.ts).
 *
 * NOT a mail server: it listens on 127.0.0.1 only, accepts what a mailbox
 * sends, records the envelope and the subject of every message, and throws
 * the body away. Nothing is relayed anywhere. A control API switches it to
 * refuse logins (535), so the drill can fail a mailbox on purpose and watch
 * the platform hold its queue, alert and recover.
 *
 *   pnpm exec tsx scripts/drill/smtp-sink.ts
 *
 * Environment (all optional):
 *   SINK_SMTP_PORT     SMTP port (default 2525)
 *   SINK_CONTROL_PORT  control API port (default 2526)
 *   SINK_USER / SINK_PASSWORD
 *                      the only login accepted; unset = any login is accepted
 *   SINK_DELAY_MS      wait this long before accepting each message (slows a
 *                      drain down so it can be paused half-way)
 *
 * Control API (JSON over HTTP, 127.0.0.1 only):
 *   GET  /state                  { auth, delayMs, received, authAccepted, authRejected }
 *   GET  /messages               [{ seq, at, from, to, subject, size }]
 *   POST /auth?mode=reject       refuse every login with 535 (accept to undo)
 *   POST /delay?ms=1000          per-message delay
 *   POST /reset                  forget messages and counters (keeps auth + delay)
 *
 * The drill imports startSmtpSink() and drives it in-process; run as a
 * script it serves until Ctrl-C.
 */

import http from 'node:http';
import { SMTPServer, type SMTPServerAuthentication } from 'smtp-server';

export type SinkAuthMode = 'accept' | 'reject';

export interface SinkMessage {
  seq: number;
  at: string;
  from: string | null;
  to: string[];
  subject: string | null;
  size: number;
}

export interface SinkState {
  auth: SinkAuthMode;
  delayMs: number;
  received: number;
  authAccepted: number;
  authRejected: number;
}

export interface SmtpSinkOptions {
  smtpPort?: number;
  /** null = no control API (in-process use only). */
  controlPort?: number | null;
  user?: string | null;
  password?: string | null;
  delayMs?: number;
  /** Bind address; the sink refuses anything but a loopback address. */
  host?: string;
}

export interface SmtpSink {
  readonly smtpPort: number;
  readonly controlPort: number | null;
  state(): SinkState;
  messages(): SinkMessage[];
  setAuth(mode: SinkAuthMode): void;
  setDelay(ms: number): void;
  reset(): void;
  close(): Promise<void>;
}

/** Headers we keep: the subject, to tell the drill's messages apart. */
const MAX_HEADER_BYTES = 16 * 1024;

function subjectOf(headerBlock: string): string | null {
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const m = /^subject:[ \t]*(.*)$/im.exec(unfolded);
  return m ? m[1]!.trim() : null;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export async function startSmtpSink(options: SmtpSinkOptions = {}): Promise<SmtpSink> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopback(host)) throw new Error(`smtp-sink binds loopback only, not ${host}`);
  const smtpPort = options.smtpPort ?? 2525;
  const controlPort = options.controlPort === undefined ? 2526 : options.controlPort;
  const expectedUser = options.user ?? null;
  const expectedPassword = options.password ?? null;

  let auth: SinkAuthMode = 'accept';
  let delayMs = Math.max(0, options.delayMs ?? 0);
  let seq = 0;
  let authAccepted = 0;
  let authRejected = 0;
  let received: SinkMessage[] = [];

  const smtp = new SMTPServer({
    name: 'drill-sink.localhost',
    banner: 'Leadsonar drill sink (records only, relays nothing)',
    // Plain SMTP on a non-standard port: no STARTTLS to negotiate, so the
    // login is sent in the clear — fine on loopback, and what lets the
    // drill's credential-free probe and the real send see the same server.
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN'],
    size: 10 * 1024 * 1024,
    logger: false,
    onAuth(a: SMTPServerAuthentication, _session, callback) {
      const credentialsOk =
        (expectedUser === null || a.username === expectedUser) &&
        (expectedPassword === null || a.password === expectedPassword);
      if (auth === 'reject' || !credentialsOk) {
        authRejected += 1;
        const err = new Error('5.7.8 Authentication credentials invalid') as Error & {
          responseCode?: number;
        };
        err.responseCode = 535;
        callback(err);
        return;
      }
      authAccepted += 1;
      callback(null, { user: a.username });
    },
    onData(stream, session, callback) {
      let size = 0;
      let header = '';
      let headerDone = false;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (headerDone || header.length >= MAX_HEADER_BYTES) return;
        header += chunk.toString('utf8');
        const end = header.search(/\r?\n\r?\n/);
        if (end >= 0) {
          header = header.slice(0, end);
          headerDone = true;
        }
      });
      stream.on('end', () => {
        const finish = () => {
          seq += 1;
          received.push({
            seq,
            at: new Date().toISOString(),
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : null,
            to: session.envelope.rcptTo.map((r) => r.address),
            subject: subjectOf(header),
            size,
          });
          callback();
        };
        if (delayMs > 0) setTimeout(finish, delayMs);
        else finish();
      });
    },
  });
  smtp.on('error', (err) => console.error('[smtp-sink] smtp error:', err.message));
  await new Promise<void>((resolve, reject) => {
    smtp.server.once('error', reject);
    smtp.listen(smtpPort, host, () => resolve());
  });

  const api: SmtpSink = {
    smtpPort,
    controlPort,
    state: () => ({ auth, delayMs, received: received.length, authAccepted, authRejected }),
    messages: () => received.slice(),
    setAuth: (mode) => {
      auth = mode;
    },
    setDelay: (ms) => {
      delayMs = Math.max(0, Math.floor(ms));
    },
    reset: () => {
      received = [];
      seq = 0;
      authAccepted = 0;
      authRejected = 0;
    },
    close: async () => {
      await new Promise<void>((resolve) => smtp.close(() => resolve()));
      if (control) await new Promise<void>((resolve) => control!.close(() => resolve()));
    },
  };

  let control: http.Server | null = null;
  if (controlPort !== null) {
    control = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://sink.local');
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && url.pathname === '/state') return send(200, api.state());
      if (req.method === 'GET' && url.pathname === '/messages') return send(200, api.messages());
      if (req.method === 'POST' && url.pathname === '/auth') {
        const mode = url.searchParams.get('mode');
        if (mode !== 'accept' && mode !== 'reject')
          return send(400, { error: 'mode=accept|reject' });
        api.setAuth(mode);
        return send(200, api.state());
      }
      if (req.method === 'POST' && url.pathname === '/delay') {
        const ms = Number(url.searchParams.get('ms'));
        if (!Number.isFinite(ms) || ms < 0) return send(400, { error: 'ms=<non-negative number>' });
        api.setDelay(ms);
        return send(200, api.state());
      }
      if (req.method === 'POST' && url.pathname === '/reset') {
        api.reset();
        return send(200, api.state());
      }
      return send(404, { error: 'not found' });
    });
    await new Promise<void>((resolve, reject) => {
      control!.once('error', reject);
      control!.listen(controlPort, host, () => resolve());
    });
  }
  return api;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

const isMain = (() => {
  const entry = process.argv[1] ?? '';
  return /smtp-sink\.(ts|js|cjs|mjs)$/.test(entry);
})();

if (isMain) {
  startSmtpSink({
    smtpPort: envInt('SINK_SMTP_PORT', 2525),
    controlPort: envInt('SINK_CONTROL_PORT', 2526),
    user: process.env.SINK_USER || null,
    password: process.env.SINK_PASSWORD || null,
    delayMs: envInt('SINK_DELAY_MS', 0),
  })
    .then((sink) => {
      console.log(
        `[smtp-sink] SMTP on 127.0.0.1:${sink.smtpPort}, control API on 127.0.0.1:${sink.controlPort}`,
      );
      const stop = () => {
        void sink.close().then(() => process.exit(0));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err: unknown) => {
      console.error('[smtp-sink] failed to start:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
