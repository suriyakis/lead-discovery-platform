// nodemailer (SMTP) + imapflow (IMAP) implementation of IMailProvider.

import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser, type MailParserOptions } from 'mailparser';
import type {
  ConnectionCheck,
  ConnectionTestResult,
  FetchInboundOptions,
  IMailProvider,
  InboundMessage,
  MailAddress,
  MailboxConfig,
  OutboundMessage,
  SendResult,
} from './index';
import {
  deliveryStatusText,
  extractRelevanceSignals,
  unfoldHeaderValue,
} from './relevance';
import { classifyMailboxFailure, describeConnectionError, isAuthFailure } from './connection-errors';
import { resolveImapSecure, resolveSmtpSecure } from './ports';

const DEFAULT_TIMEOUT_MS = 20_000;

// Port-aware TLS mode: ./ports.ts (pure, shared with the PC-09
// credential-free probe, which must not load nodemailer / imapflow).
export { resolveImapSecure, resolveSmtpSecure } from './ports';

/**
 * The nodemailer transport options for a mailbox. Port 465 always gets
 * implicit TLS (`secure: true`, TLS before the greeting); 587 / 25 get a
 * plain connect that nodemailer upgrades with STARTTLS whenever the server
 * offers it. flow:F-04: hosts that refuse 587 (the Plesk host behind
 * workspace 1's mailbox listens on 25 / 465 / 993 only) work by switching
 * the mailbox to 465 — exported so that stays pinned by a test.
 */
export function smtpTransportOptions(config: MailboxConfig): SMTPTransport.Options {
  return {
    host: config.smtpHost,
    port: config.smtpPort,
    secure: resolveSmtpSecure(config.smtpPort, config.smtpSecure),
    auth: {
      user: config.smtpUser,
      pass: config.smtpPassword,
    },
    tls: { rejectUnauthorized: false },
    connectionTimeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    socketTimeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export class SmtpImapMailProvider implements IMailProvider {
  public readonly id = 'smtp-imap';
  private readonly config: MailboxConfig;
  private transporter: Transporter | null = null;

  constructor(config: MailboxConfig) {
    this.config = config;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const transporter = this.transporter ?? this.buildTransporter();
    this.transporter = transporter;

    const info = await transporter.sendMail({
      from: addrToString(message.from),
      to: message.to.map(addrToString),
      cc: message.cc?.map(addrToString),
      bcc: message.bcc?.map(addrToString),
      replyTo: message.replyTo,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.headers,
      attachments: message.attachments?.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: a.content,
      })),
    });

    return {
      messageId: info.messageId,
      raw: info.response,
      rejected: partialRejections(info),
    };
  }

  async fetchInbound(options: FetchInboundOptions = {}): Promise<InboundMessage[]> {
    if (!this.config.imap) return [];
    const since = options.since;
    const limit = options.limit ?? 100;

    const client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: resolveImapSecure(this.config.imap.port, this.config.imap.secure),
      auth: {
        user: this.config.imap.user,
        pass: this.config.imap.password,
      },
      logger: false,
      tls: { rejectUnauthorized: false },
      socketTimeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    await client.connect();
    const out: InboundMessage[] = [];
    try {
      await client.mailboxOpen(this.config.imap.folder);
      const searchCriteria: Record<string, unknown> = {};
      if (since) searchCriteria.since = since;

      let count = 0;
      for await (const msg of client.fetch(searchCriteria, {
        envelope: true,
        bodyStructure: true,
        source: true,
      })) {
        if (count >= limit) break;
        const parsed = await parseFetched(msg);
        if (parsed) out.push(parsed);
        count++;
      }
    } finally {
      await client.logout().catch(() => undefined);
    }

    return out;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const smtp = await this.testSmtp();
    const imap = this.config.imap ? await this.testImap() : null;
    return { smtp, imap };
  }

  /** PC-09: the daily verify — one authenticated SMTP check, no IMAP. */
  async verifySmtp(): Promise<ConnectionCheck> {
    return this.testSmtp();
  }

  // ---- helpers --------------------------------------------------------

  private buildTransporter(): Transporter {
    return nodemailer.createTransport(smtpTransportOptions(this.config));
  }

  private async testSmtp(): Promise<ConnectionCheck> {
    const transporter = this.buildTransporter();
    try {
      await transporter.verify();
      return { ok: true };
    } catch (err) {
      return failedCheck(err);
    } finally {
      transporter.close();
    }
  }

  private async testImap(): Promise<ConnectionCheck> {
    if (!this.config.imap) return { ok: false, detail: 'imap not configured' };
    const client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: resolveImapSecure(this.config.imap.port, this.config.imap.secure),
      auth: { user: this.config.imap.user, pass: this.config.imap.password },
      logger: false,
      tls: { rejectUnauthorized: false },
      socketTimeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    try {
      await client.connect();
      await client.mailboxOpen(this.config.imap.folder);
      return { ok: true };
    } catch (err) {
      return failedCheck(err);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}

// ---- parsing helpers --------------------------------------------------

async function parseFetched(msg: FetchMessageObject): Promise<InboundMessage | null> {
  if (!msg.source) return null;
  return parseRawMessage(msg.source, msg.uid ?? 0);
}

/**
 * Parse one raw RFC 5322 message into an InboundMessage. Exported so the
 * relevance gate can be tested on real .eml fixtures through the real
 * parser.
 *
 * flow:F-01: the relevance signals are captured here, from the raw header
 * lines and the report parts, because mailparser's structured header map
 * folds every List-* header into one 'list' object and returns objects for
 * Content-Type / addresses — the old String() pass stored those as
 * '[object Object]'. `keepDeliveryStatus` keeps a DSN's
 * message/delivery-status part as a part we can read instead of dropping
 * it; its text is appended to the body so the operator still sees it.
 */
export async function parseRawMessage(
  source: Buffer | string,
  uid = 0,
): Promise<InboundMessage | null> {
  const parsed = await simpleParser(source, PARSER_OPTIONS);

  const from = pickFirstAddress(parsed.from?.value);
  if (!from) return null;
  const messageId = (parsed.messageId ?? '').trim();
  if (!messageId) return null;

  const headers = jsonSafeHeaders(parsed.headerLines ?? [], parsed.headers);

  const referencesRaw = parsed.references;
  const references = Array.isArray(referencesRaw)
    ? referencesRaw
    : referencesRaw
    ? [referencesRaw]
    : [];

  const attachments = (parsed.attachments ?? []).map((a) => ({
    filename: a.filename ?? 'unnamed',
    contentType: a.contentType ?? 'application/octet-stream',
    sizeBytes: a.size ?? 0,
    content: a.content as Buffer,
  }));

  const relevanceSignals = extractRelevanceSignals({
    headers,
    fromAddress: from.address,
    parts: attachments.map((a) => ({ contentType: a.contentType, content: a.content })),
    source: 'parser',
  });

  let textBody = parsed.text ?? null;
  const report = deliveryStatusText(attachments);
  if (report && !(textBody ?? '').includes(report)) {
    textBody = textBody ? `${textBody.trimEnd()}\n\n${report}\n` : `${report}\n`;
  }

  return {
    uid,
    messageId,
    inReplyTo: parsed.inReplyTo ?? null,
    references,
    from,
    to: collectAddresses(parsed.to),
    cc: collectAddresses(parsed.cc),
    subject: parsed.subject ?? '',
    textBody,
    htmlBody: typeof parsed.html === 'string' ? parsed.html : null,
    receivedAt: parsed.date ?? new Date(),
    headers,
    relevanceSignals,
    attachments,
  };
}

/** mailparser supports keepDeliveryStatus (mail-parser.js) but
 *  @types/mailparser does not declare it. */
const PARSER_OPTIONS: MailParserOptions & { keepDeliveryStatus: boolean } = {
  keepDeliveryStatus: true,
};

/** Headers whose decoded (encoded-word) text is worth keeping over the raw line. */
const DECODED_TEXT_HEADERS = ['subject', 'from', 'to', 'cc', 'reply-to', 'sender'] as const;

/**
 * JSON-safe header record: lower-cased name → unfolded raw value, an array
 * when the header repeats. Built from the raw header lines so List-*,
 * Content-Type and friends keep their real values; the few human-facing
 * headers take mailparser's decoded text so encoded words read normally.
 */
function jsonSafeHeaders(
  lines: ReadonlyArray<{ key: string; line: string }>,
  decoded: ReadonlyMap<string, unknown>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const { key, line } of lines) {
    const name = key.toLowerCase();
    const value = unfoldHeaderValue(line);
    const prev = out[name];
    out[name] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
  }
  for (const name of DECODED_TEXT_HEADERS) {
    if (Array.isArray(out[name])) continue;
    const value = decoded.get(name);
    if (typeof value === 'string') {
      out[name] = value;
    } else if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
      out[name] = (value as { text: string }).text;
    }
  }
  return out;
}

function pickFirstAddress(
  list: ReadonlyArray<{ address?: string; name?: string }> | undefined,
): MailAddress | null {
  if (!list || list.length === 0) return null;
  const first = list[0]!;
  if (!first.address) return null;
  return { address: first.address.toLowerCase(), name: first.name };
}

function collectAddresses(
  field:
    | { value?: ReadonlyArray<{ address?: string; name?: string }> }
    | ReadonlyArray<{ value?: ReadonlyArray<{ address?: string; name?: string }> }>
    | undefined,
): MailAddress[] {
  if (!field) return [];
  const lists = Array.isArray(field) ? field : [field];
  const out: MailAddress[] = [];
  for (const part of lists) {
    for (const entry of part.value ?? []) {
      if (entry.address) {
        out.push({ address: entry.address.toLowerCase(), name: entry.name });
      }
    }
  }
  return out;
}

function addrToString(addr: MailAddress): string {
  return addr.name ? `"${addr.name.replace(/"/g, '\\"')}" <${addr.address}>` : addr.address;
}

/** flow:F-05 — nodemailer accepts a message when at least one recipient
 *  passed RCPT TO and lists the refused ones (with the server's reply) on
 *  `rejectedErrors`. Surface them so the service can tell a non-existent
 *  address from a delivered one. */
function partialRejections(info: unknown): SendResult['rejected'] {
  const errors = (info as { rejectedErrors?: unknown }).rejectedErrors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const out: NonNullable<SendResult['rejected']>[number][] = [];
  for (const raw of errors) {
    const e = (raw ?? {}) as { recipient?: unknown; responseCode?: unknown; response?: unknown };
    if (typeof e.recipient !== 'string') continue;
    out.push({
      address: e.recipient,
      responseCode: typeof e.responseCode === 'number' ? e.responseCode : null,
      response: typeof e.response === 'string' ? e.response : null,
    });
  }
  return out.length > 0 ? out : undefined;
}

/** flow:F-04: keep the server's response code / text (imapflow's refused
 *  LOGIN is a bare "Command failed" otherwise). */
function explain(err: unknown): string {
  return describeConnectionError(err);
}

/** A failed check with its recovery class read from the thrown error
 *  (PC-09: nodemailer / imapflow codes are more precise than the text). */
function failedCheck(err: unknown): ConnectionCheck {
  return {
    ok: false,
    detail: explain(err),
    authFailed: isAuthFailure(err),
    failureClass: classifyMailboxFailure({ error: err }),
  };
}
