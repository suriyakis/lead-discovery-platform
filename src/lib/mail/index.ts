// Mail provider abstraction.
//
// One IMailProvider per mailbox. Encapsulates SMTP send + IMAP fetch
// behind a narrow interface so the service layer stays free of nodemailer
// / imapflow specifics, and so tests can inject a deterministic mock.
//
// Real adapters land in ./smtp-imap.ts (lazy-imported by the factory).

export interface MailAddress {
  address: string;
  name?: string;
}

export interface OutboundMessage {
  from: MailAddress;
  to: ReadonlyArray<MailAddress>;
  cc?: ReadonlyArray<MailAddress>;
  bcc?: ReadonlyArray<MailAddress>;
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  /** Custom headers (e.g., In-Reply-To, References) — keys preserve case. */
  headers?: Record<string, string>;
  /** Inline attachments. Buffer-form only for Phase 10. */
  attachments?: ReadonlyArray<{
    filename: string;
    contentType?: string;
    content: Buffer;
  }>;
}

export interface SendResult {
  /** RFC 5322 Message-ID assigned by the server. */
  messageId: string;
  /** Provider raw response for audit. */
  raw?: string;
}

export interface InboundMessage {
  uid: number;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  receivedAt: Date;
  /** Decoded headers for audit. */
  headers: Record<string, string | string[]>;
  attachments: Array<{
    filename: string;
    contentType: string;
    sizeBytes: number;
    content: Buffer;
  }>;
}

export interface FetchInboundOptions {
  /** Only return messages received strictly after this date. */
  since?: Date;
  /** Hard cap. Default 100. */
  limit?: number;
}

export interface ConnectionTestResult {
  smtp: { ok: boolean; detail?: string };
  imap: { ok: boolean; detail?: string } | null;
}

export interface MailboxConfig {
  /** Outbound. */
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  /** Inbound. Set null for outbound-only mailboxes. */
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    folder: string;
  } | null;
  /** Connect timeout in ms. */
  timeoutMs?: number;
}

export interface IMailProvider {
  readonly id: string;
  send(message: OutboundMessage): Promise<SendResult>;
  fetchInbound(options?: FetchInboundOptions): Promise<InboundMessage[]>;
  testConnection(): Promise<ConnectionTestResult>;
}

// ---- mock implementation -----------------------------------------------

interface SentRecord {
  message: OutboundMessage;
  result: SendResult;
}

export class MockMailProvider implements IMailProvider {
  public readonly id = 'mock';
  public readonly sent: SentRecord[] = [];
  public readonly inbox: InboundMessage[] = [];

  /** Tests can push synthetic inbound messages here before calling fetchInbound. */
  enqueueInbound(...messages: InboundMessage[]): void {
    this.inbox.push(...messages);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const messageId = `<mock-${Date.now()}-${this.sent.length}@mock.local>`;
    const result: SendResult = { messageId, raw: 'mock-ok' };
    this.sent.push({ message, result });
    return result;
  }

  async fetchInbound(options: FetchInboundOptions = {}): Promise<InboundMessage[]> {
    const since = options.since;
    const filtered = since
      ? this.inbox.filter((m) => m.receivedAt > since)
      : [...this.inbox];
    const limit = options.limit ?? 100;
    return filtered.slice(0, limit);
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return {
      smtp: { ok: true, detail: 'mock smtp always healthy' },
      imap: { ok: true, detail: 'mock imap always healthy' },
    };
  }
}

// ---- factory -----------------------------------------------------------

/**
 * Build a real (nodemailer + imapflow) provider from a resolved mailbox
 * config. Real config keys are loaded by the service layer from the DB
 * (mailboxes table) + `workspace_secrets` (passwords). Tests bypass this
 * and inject a `MockMailProvider` directly.
 */
export function createMailProvider(config: MailboxConfig): IMailProvider {
  // Lazy import — keeps nodemailer/imapflow out of the bundle when only
  // mock is in use (tests, dev with no real mailbox configured).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SmtpImapMailProvider } = require('./smtp-imap') as typeof import('./smtp-imap');
  return new SmtpImapMailProvider(config);
}

// Tests inject providers per-call rather than via a global cached factory.
// (Each mailbox has its own provider; there's no single "default" to cache.)
