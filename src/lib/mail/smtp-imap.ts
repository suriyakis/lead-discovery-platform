// nodemailer (SMTP) + imapflow (IMAP) implementation of IMailProvider.

import nodemailer, { type Transporter } from 'nodemailer';
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type {
  ConnectionTestResult,
  FetchInboundOptions,
  IMailProvider,
  InboundMessage,
  MailAddress,
  MailboxConfig,
  OutboundMessage,
  SendResult,
} from './index';

const DEFAULT_TIMEOUT_MS = 20_000;

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

    return { messageId: info.messageId, raw: info.response };
  }

  async fetchInbound(options: FetchInboundOptions = {}): Promise<InboundMessage[]> {
    if (!this.config.imap) return [];
    const since = options.since;
    const limit = options.limit ?? 100;

    const client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      auth: {
        user: this.config.imap.user,
        pass: this.config.imap.password,
      },
      logger: false,
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

  // ---- helpers --------------------------------------------------------

  private buildTransporter(): Transporter {
    return nodemailer.createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: this.config.smtpSecure,
      auth: {
        user: this.config.smtpUser,
        pass: this.config.smtpPassword,
      },
      connectionTimeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      socketTimeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  private async testSmtp(): Promise<{ ok: boolean; detail?: string }> {
    const transporter = this.buildTransporter();
    try {
      await transporter.verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: explain(err) };
    } finally {
      transporter.close();
    }
  }

  private async testImap(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.config.imap) return { ok: false, detail: 'imap not configured' };
    const client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      auth: { user: this.config.imap.user, pass: this.config.imap.password },
      logger: false,
      socketTimeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    try {
      await client.connect();
      await client.mailboxOpen(this.config.imap.folder);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: explain(err) };
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}

// ---- parsing helpers --------------------------------------------------

async function parseFetched(msg: FetchMessageObject): Promise<InboundMessage | null> {
  if (!msg.source) return null;
  const parsed = await simpleParser(msg.source);

  const from = pickFirstAddress(parsed.from?.value);
  if (!from) return null;
  const messageId = (parsed.messageId ?? '').trim();
  if (!messageId) return null;

  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of parsed.headers.entries()) {
    headers[key] =
      typeof value === 'string'
        ? value
        : Array.isArray(value)
        ? value.map(String)
        : String(value);
  }

  const referencesRaw = parsed.references;
  const references = Array.isArray(referencesRaw)
    ? referencesRaw
    : referencesRaw
    ? [referencesRaw]
    : [];

  return {
    uid: msg.uid ?? 0,
    messageId,
    inReplyTo: parsed.inReplyTo ?? null,
    references,
    from,
    to: collectAddresses(parsed.to),
    cc: collectAddresses(parsed.cc),
    subject: parsed.subject ?? '',
    textBody: parsed.text ?? null,
    htmlBody: typeof parsed.html === 'string' ? parsed.html : null,
    receivedAt: parsed.date ?? new Date(),
    headers,
    attachments: (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? 'unnamed',
      contentType: a.contentType ?? 'application/octet-stream',
      sizeBytes: a.size ?? 0,
      content: a.content as Buffer,
    })),
  };
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

function explain(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
