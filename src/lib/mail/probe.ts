// PC-09 — the credential-free mail-server probe.
//
// "Does the server answer?" without ever logging in. A mailbox-health probe
// runs every 30 minutes per active mailbox and, for a mailbox failing with
// a connection error, on a 30 min → 6 h backoff. Logging in that often is
// what a shared host's fail2ban counts (and a stale password turns every
// login into a failed one), so the probe speaks only the unauthenticated
// part of each protocol:
//
//   SMTP  TCP (TLS on connect for 465) → 220 greeting → EHLO (HELO when
//         EHLO is refused) → STARTTLS + EHLO again when the server offers
//         it on a plain port → QUIT
//   IMAP  TCP (TLS on connect for 993) → "* OK" greeting → CAPABILITY →
//         STARTTLS + CAPABILITY again when offered on a plain port →
//         LOGOUT
//
// It never sends AUTH, LOGIN, AUTHENTICATE, MAIL, RCPT or anything after
// the capability exchange (the tests run it against mock servers that
// record every command). TLS uses the same port rules as the provider
// (./ports.ts) and, like it, does not reject unverifiable certificates: a
// probe that failed where the real login succeeds would fail the mailbox
// for nothing. Pure network code, no DB; services/mailbox-probes.ts decides
// what a result means.

import net from 'node:net';
import tls from 'node:tls';
import { hostname } from 'node:os';
import { resolveImapSecure, resolveSmtpSecure } from './ports';
import type { MailProtocol } from './connection-errors';

export const PROBE_TIMEOUT_MS = 15_000;

export interface ProbeEndpoint {
  protocol: MailProtocol;
  host: string;
  port: number;
  /** The mailbox's SSL/TLS setting (port rules win, as in the provider). */
  secure: boolean;
  timeoutMs?: number;
}

/** How far the conversation got. */
export type ProbeStage =
  | 'connect'
  | 'tls'
  | 'greeting'
  | 'ehlo'
  | 'starttls'
  | 'capability'
  | 'done';

export interface ProbeResult {
  ok: boolean;
  protocol: MailProtocol;
  host: string;
  port: number;
  /** The stage that failed, or 'done'. */
  stage: ProbeStage;
  /** One line for people and lastError: what answered or what broke. */
  detail: string;
  /** The session ended up encrypted (TLS on connect or STARTTLS). */
  encrypted: boolean;
  /** Command verbs sent, in order (EHLO, STARTTLS, QUIT, …): never a
   *  credential, so safe to log. */
  commands: string[];
}

/** The EHLO name, as nodemailer picks it (smtp-connection _getHostname):
 *  the host name when it is a dotted name, else a bracketed address. */
export function ehloName(host: string = safeHostname()): string {
  if (!host || !host.includes('.')) return '[127.0.0.1]';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return `[${host}]`;
  return host;
}

function safeHostname(): string {
  try {
    return hostname() || '';
  } catch {
    return '';
  }
}

class ProbeFailure extends Error {
  constructor(
    public readonly stage: ProbeStage,
    message: string,
  ) {
    super(message);
    this.name = 'ProbeFailure';
  }
}

/** A line reader over a socket that can be swapped for its TLS upgrade. */
class Conversation {
  private buffer = '';
  private lines: string[] = [];
  private waiter: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null;
  private failure: Error | null = null;
  private socket: net.Socket;
  readonly commands: string[] = [];
  encrypted: boolean;

  constructor(socket: net.Socket, encrypted: boolean) {
    this.socket = socket;
    this.encrypted = encrypted;
    this.attach(socket);
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer += chunk.toString('latin1');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      this.push(line);
    }
  };

  private readonly onError = (err: Error) => this.fail(err);
  private readonly onClose = () => this.fail(new Error('connection closed by the server'));

  private attach(socket: net.Socket): void {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  private detach(socket: net.Socket): void {
    socket.off('data', this.onData);
    socket.off('error', this.onError);
    socket.off('close', this.onClose);
  }

  private push(line: string): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(line);
    } else {
      this.lines.push(line);
    }
  }

  fail(err: Error): void {
    if (!this.failure) this.failure = err;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(err);
    }
  }

  readLine(): Promise<string> {
    const next = this.lines.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  send(verb: string, line: string): void {
    this.commands.push(verb);
    this.socket.write(`${line}\r\n`);
  }

  /** STARTTLS: hand the plain socket to TLS and keep reading from it. */
  async upgrade(servername: string): Promise<void> {
    const plain = this.socket;
    this.detach(plain);
    this.buffer = '';
    this.lines = [];
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({
        socket: plain,
        servername: net.isIP(servername) ? undefined : servername,
        rejectUnauthorized: false,
      });
      s.once('secureConnect', () => resolve(s));
      s.once('error', reject);
    });
    this.socket = secure;
    this.encrypted = true;
    this.attach(secure);
  }

  /** Flush what was written (QUIT / LOGOUT), then let go of the socket. */
  close(): void {
    const s = this.socket;
    this.detach(s);
    endSocket(s);
  }
}

/** end() so a written QUIT still goes out; destroy shortly after in case
 *  the server never closes its side. */
function endSocket(s: net.Socket): void {
  s.on('error', () => undefined);
  s.end();
  setTimeout(() => s.destroy(), 1000).unref();
}

/** Open the connection (TLS on connect when the port says so). `track`
 *  receives the socket at once, so a timeout can close a pending connect. */
function connect(
  endpoint: ProbeEndpoint,
  implicitTls: boolean,
  track: (s: net.Socket) => void,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = implicitTls
      ? tls.connect({
          host: endpoint.host,
          port: endpoint.port,
          servername: net.isIP(endpoint.host) ? undefined : endpoint.host,
          rejectUnauthorized: false,
        })
      : net.connect({ host: endpoint.host, port: endpoint.port });
    track(s);
    const onError = (err: Error) => {
      // A TLS-on-connect socket reports a refused TCP connect here too.
      const tcp = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/.test(describe(err));
      reject(new ProbeFailure(implicitTls && !tcp ? 'tls' : 'connect', describe(err)));
    };
    s.once('error', onError);
    s.once(implicitTls ? 'secureConnect' : 'connect', () => {
      s.off('error', onError);
      resolve(s);
    });
  });
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' && !err.message.includes(code) ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

interface SmtpReply {
  code: number;
  text: string;
  lines: string[];
}

/** One SMTP reply: "250-…" continues, "250 …" (or a bare code) ends it. */
async function readSmtpReply(c: Conversation, stage: ProbeStage): Promise<SmtpReply> {
  const lines: string[] = [];
  for (;;) {
    let line: string;
    try {
      line = await c.readLine();
    } catch (err) {
      throw new ProbeFailure(stage, describe(err));
    }
    const m = line.match(/^(\d{3})([ -]?)(.*)$/);
    if (!m) throw new ProbeFailure(stage, `not an SMTP reply: ${line.slice(0, 120)}`);
    lines.push(m[3] ?? '');
    if (m[2] !== '-') return { code: Number(m[1]), text: line, lines };
  }
}

async function smtpConversation(c: Conversation, endpoint: ProbeEndpoint): Promise<string> {
  const greeting = await readSmtpReply(c, 'greeting');
  if (greeting.code !== 220) throw new ProbeFailure('greeting', `greeting: ${greeting.text}`);
  const name = ehloName();

  const hello = async (): Promise<SmtpReply> => {
    c.send('EHLO', `EHLO ${name}`);
    const ehlo = await readSmtpReply(c, 'ehlo');
    if (ehlo.code === 250) return ehlo;
    c.send('HELO', `HELO ${name}`);
    const helo = await readSmtpReply(c, 'ehlo');
    if (helo.code !== 250) throw new ProbeFailure('ehlo', `EHLO / HELO refused: ${helo.text}`);
    return helo;
  };

  let ehlo = await hello();
  const offersStartTls = ehlo.lines.some((l) => /^STARTTLS\b/i.test(l.trim()));
  if (!c.encrypted && offersStartTls) {
    c.send('STARTTLS', 'STARTTLS');
    const ready = await readSmtpReply(c, 'starttls');
    if (ready.code !== 220) throw new ProbeFailure('starttls', `STARTTLS refused: ${ready.text}`);
    try {
      await c.upgrade(endpoint.host);
    } catch (err) {
      throw new ProbeFailure('starttls', `STARTTLS handshake failed: ${describe(err)}`);
    }
    ehlo = await hello();
  }
  // A polite goodbye; the answer does not matter.
  c.send('QUIT', 'QUIT');
  return `${greeting.text.slice(0, 120)}${c.encrypted ? ' (TLS)' : ' (no TLS)'}`;
}

/** Read IMAP lines until the tagged completion; returns [untagged…, tagged]. */
async function readImapUntil(c: Conversation, tag: string, stage: ProbeStage): Promise<string[]> {
  const lines: string[] = [];
  for (;;) {
    let line: string;
    try {
      line = await c.readLine();
    } catch (err) {
      throw new ProbeFailure(stage, describe(err));
    }
    lines.push(line);
    if (line.startsWith(`${tag} `)) return lines;
  }
}

async function imapConversation(c: Conversation, endpoint: ProbeEndpoint): Promise<string> {
  let greeting: string;
  try {
    greeting = await c.readLine();
  } catch (err) {
    throw new ProbeFailure('greeting', describe(err));
  }
  if (!/^\* (OK|PREAUTH)\b/i.test(greeting)) {
    throw new ProbeFailure('greeting', `greeting: ${greeting.slice(0, 120)}`);
  }
  const capability = async (tag: string): Promise<string[]> => {
    c.send('CAPABILITY', `${tag} CAPABILITY`);
    const lines = await readImapUntil(c, tag, 'capability');
    const done = lines[lines.length - 1]!;
    if (!new RegExp(`^${tag} OK\\b`, 'i').test(done)) {
      throw new ProbeFailure('capability', `CAPABILITY refused: ${done.slice(0, 120)}`);
    }
    return lines;
  };

  const caps = await capability('p1');
  const offersStartTls = caps.some((l) => /^\* CAPABILITY\b.*\bSTARTTLS\b/i.test(l));
  if (!c.encrypted && offersStartTls) {
    c.send('STARTTLS', 'p2 STARTTLS');
    const lines = await readImapUntil(c, 'p2', 'starttls');
    const done = lines[lines.length - 1]!;
    if (!/^p2 OK\b/i.test(done)) throw new ProbeFailure('starttls', `STARTTLS refused: ${done.slice(0, 120)}`);
    try {
      await c.upgrade(endpoint.host);
    } catch (err) {
      throw new ProbeFailure('starttls', `STARTTLS handshake failed: ${describe(err)}`);
    }
    await capability('p3');
  }
  c.send('LOGOUT', 'p9 LOGOUT');
  return `${greeting.slice(0, 120)}${c.encrypted ? ' (TLS)' : ' (no TLS)'}`;
}

/**
 * Probe one mail server without credentials. Never throws: every failure
 * is a result (stage + detail). The whole conversation is bounded by
 * `timeoutMs` (default 15 s).
 */
export async function probeMailServer(endpoint: ProbeEndpoint): Promise<ProbeResult> {
  const implicitTls =
    endpoint.protocol === 'smtp'
      ? resolveSmtpSecure(endpoint.port, endpoint.secure)
      : resolveImapSecure(endpoint.port, endpoint.secure);
  const base = { protocol: endpoint.protocol, host: endpoint.host, port: endpoint.port };
  const timeoutMs = endpoint.timeoutMs ?? PROBE_TIMEOUT_MS;
  let conversation: Conversation | null = null;
  let rawSocket: net.Socket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stage: ProbeStage = 'connect';

  const work = (async (): Promise<ProbeResult> => {
    const socket = await connect(endpoint, implicitTls, (s) => {
      rawSocket = s;
    });
    stage = 'greeting';
    conversation = new Conversation(socket, implicitTls);
    const detail =
      endpoint.protocol === 'smtp'
        ? await smtpConversation(conversation, endpoint)
        : await imapConversation(conversation, endpoint);
    return {
      ...base,
      ok: true,
      stage: 'done',
      detail,
      encrypted: conversation.encrypted,
      commands: [...conversation.commands],
    };
  })();

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ProbeFailure(stage, `no answer within ${Math.round(timeoutMs / 1000)} s (timed out)`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([work, timeout]);
  } catch (err) {
    const c = conversation as Conversation | null;
    const failedStage = err instanceof ProbeFailure ? err.stage : stage;
    return {
      ...base,
      ok: false,
      stage: failedStage,
      detail: `${endpoint.host}:${endpoint.port} ${failedStage}: ${err instanceof Error ? err.message : String(err)}`,
      encrypted: c?.encrypted ?? false,
      commands: c ? [...c.commands] : [],
    };
  } finally {
    // Assigned inside the async closures, so read through casts (TS keeps
    // their declared null otherwise).
    const t = timer as NodeJS.Timeout | null;
    if (t) clearTimeout(t);
    // Swallow the losing branch so a late rejection is never unhandled.
    work.catch(() => undefined);
    const c = conversation as Conversation | null;
    const raw = rawSocket as net.Socket | null;
    if (c) c.close();
    else if (raw) endSocket(raw);
  }
}
