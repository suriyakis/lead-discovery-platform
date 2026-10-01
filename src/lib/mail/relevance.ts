// Inbound relevance gate — pure part (flow:F-01, X1 / I161 / I165).
//
// IMAP sync pulls EVERY message in the folder: newsletters, LinkedIn
// notifications, receipts, colleagues, bounces. Before F-01 each one was
// classified as if it were a reply to our outreach, and the classifier's
// side effects (auto-suppression, lead close, contact creation,
// translation, the "Reply from …" notification) fired on all of them.
//
// This module decides, from what the message itself carries, which of
// five classes an inbound message belongs to:
//
//   prospect_reply — proven reply to our outreach (references one of our
//                    outbound Message-IDs, or comes from the contact
//                    address of a lead we have mailed);
//   auto_reply     — the same, but machine-sent (Auto-Submitted, X-Autoreply,
//                    Precedence: bulk/junk …): vacation and OOF responders;
//   bounce         — a delivery-status notification about mail WE sent;
//   bulk           — list / ESP / no-reply / machine mail;
//   unrelated      — anything else (colleagues, vendors, DSNs for mail we
//                    never sent).
//
// Only the first three may trigger side effects; see
// services/inbound-relevance.ts for the DB-backed facts and the guards.
//
// Two pieces live here and are pure (no DB, no I/O):
//   - signal extraction from the message's headers (+ its delivery-status
//     and returned-message parts at parse time) — extractRelevanceSignals;
//   - the decision itself — classifyInboundRelevance.
//
// Signals are stored on mail_messages.relevance_signals (snake_case keys so
// they read naturally in SQL: relevance_signals->>'list_unsubscribe').
// Thread membership is deliberately NOT a signal until F-34 (I008: subject
// fallback threading merges unrelated conversations).

export const OUTREACH_RELEVANCE_VALUES = [
  'prospect_reply',
  'auto_reply',
  'bounce',
  'bulk',
  'unrelated',
] as const;

export type OutreachRelevance = (typeof OUTREACH_RELEVANCE_VALUES)[number];

/** Relevance classes proven to be about our outreach. Only these may run
 *  the reply pipeline (classification, auto-actions, outreach handler,
 *  follow-up cancellation). */
export type OutreachLinkedRelevance = Extract<
  OutreachRelevance,
  'prospect_reply' | 'auto_reply' | 'bounce'
>;

/** The outreach-linked classes as a list, for inArray() filters. */
export const OUTREACH_LINKED_RELEVANCE_VALUES: ReadonlyArray<OutreachLinkedRelevance> = [
  'prospect_reply',
  'auto_reply',
  'bounce',
];

export function isOutreachLinked(
  relevance: string | null | undefined,
): relevance is OutreachLinkedRelevance {
  return (
    relevance === 'prospect_reply' ||
    relevance === 'auto_reply' ||
    relevance === 'bounce'
  );
}

/** One per-recipient block of a delivery-status report (RFC 3464). */
export interface DsnRecipient {
  /** Lower-cased address from Final-Recipient (type prefix and <> stripped). */
  final_recipient: string;
  action: string | null;
  status: string | null;
  diagnostic_code: string | null;
}

export interface DsnReport {
  recipients: DsnRecipient[];
  /** Message-ID of the message the report is about, as written (not lower-cased). */
  original_message_id: string | null;
  /** Where original_message_id came from. */
  original_message_id_source:
    | 'delivery_status'
    | 'message_rfc822'
    | 'rfc822_headers'
    | null;
}

export type SenderRole = 'mailer_daemon' | 'postmaster' | 'noreply';

export interface InboundRelevanceSignals {
  /** 'parser' = captured from the raw message at sync time; 'stored_headers'
   *  = derived later from mail_messages.headers (backfill, test fixtures). */
  source: 'parser' | 'stored_headers';
  /** List-Id value, if any. */
  list_id: string | null;
  list_unsubscribe: boolean;
  /** Any List-* header (List-Id, -Unsubscribe, -Post, -Help …). Legacy rows
   *  only kept mailparser's folded 'list' key, so this is all they can say. */
  list_headers: boolean;
  /** Lower-cased Precedence value. */
  precedence: string | null;
  /** Lower-cased Auto-Submitted keyword (parameters dropped). */
  auto_submitted: string | null;
  /** X-Autoreply / X-Autorespond / X-Autoresponse present. */
  x_autoreply: boolean;
  x_auto_response_suppress: string | null;
  /** Names of ESP / campaign headers present (Feedback-ID, X-Mailchimp-*,
   *  X-SG-EID, X-Campaign*, X-Mailgun-*), sorted. */
  esp_markers: string[];
  /** Lower-cased top-level media type, e.g. 'multipart/report'. */
  content_type: string | null;
  /** Lower-cased report-type parameter, e.g. 'delivery-status'. */
  report_type: string | null;
  sender_role: SenderRole | null;
  /** Parsed delivery-status report, for DSNs. */
  dsn: DsnReport | null;
}

/** A body part handed to signal extraction at parse time. */
export interface RelevancePart {
  contentType: string;
  content: Buffer | string;
}

// ---- header helpers --------------------------------------------------

/** Value of a raw header line ("Key: value\r\n\tcontinued") — unfolded. */
export function unfoldHeaderValue(line: string): string {
  const colon = line.indexOf(':');
  const value = colon >= 0 ? line.slice(colon + 1) : line;
  return value.replace(/\r?\n[ \t]+/g, ' ').trim();
}

/**
 * Split a header block ("Key: value" lines, folded continuation lines)
 * into blocks separated by blank lines — the shape of a delivery-status
 * body (one per-message block, then one block per recipient) and of a
 * text/rfc822-headers part (one block). Keys are lower-cased.
 */
export function parseHeaderBlocks(text: string): Array<Map<string, string>> {
  const normalised = text.replace(/\r\n?/g, '\n');
  const blocks: Array<Map<string, string>> = [];
  for (const chunk of normalised.split(/\n[ \t]*\n/)) {
    const fields = new Map<string, string>();
    let current: { key: string; value: string } | null = null;
    const flush = () => {
      if (current && !fields.has(current.key)) {
        fields.set(current.key, current.value.trim());
      }
    };
    for (const line of chunk.split('\n')) {
      if (/^[ \t]/.test(line) && current) {
        current.value += ` ${line.trim()}`;
        continue;
      }
      const m = /^([!-9;-~]+):(.*)$/.exec(line);
      if (!m) continue;
      flush();
      current = { key: m[1]!.toLowerCase(), value: m[2]! };
    }
    flush();
    if (fields.size > 0) blocks.push(fields);
  }
  return blocks;
}

/** First string value of a stored header (string | string[] | other). */
function headerString(value: unknown): string | null {
  if (typeof value === 'string') {
    // Legacy rows String()-ified mailparser's structured values.
    return value === '[object Object]' ? null : value;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = headerString(v);
      if (s !== null) return s;
    }
  }
  return null;
}

/**
 * Lower-case lookup key for a Message-ID: trimmed, wrapped in <> when the
 * source dropped them, lower-cased. Case-insensitive matching is what
 * makes '<ABC@X.PL>' in a reply find our stored '<abc@x.pl>' (I008 b).
 */
export function messageIdKey(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  const wrapped = trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
  return wrapped.toLowerCase();
}

const ESP_MARKER_PATTERNS: ReadonlyArray<RegExp> = [
  /^feedback-id$/,
  /^x-mailchimp-/,
  /^x-mc-user$/,
  /^x-sg-eid$/,
  /^x-campaign/,
  /^x-mailgun-/,
];

const AUTOREPLY_HEADERS: ReadonlySet<string> = new Set([
  'x-autoreply',
  'x-autorespond',
  'x-autoresponse',
  'x-autoreply-from',
]);

export function senderRoleOf(address: string): SenderRole | null {
  const local = (address.split('@')[0] ?? '').toLowerCase();
  if (local === 'mailer-daemon' || local === 'mail-daemon') return 'mailer_daemon';
  if (local === 'postmaster') return 'postmaster';
  if (
    /(^|[-_.+])no[-_.]?reply([-_.+]|$)/.test(local) ||
    /(^|[-_.+])do[-_.]?not[-_.]?reply([-_.+]|$)/.test(local)
  ) {
    return 'noreply';
  }
  return null;
}

function parseContentType(raw: string | null): { type: string | null; reportType: string | null } {
  if (!raw) return { type: null, reportType: null };
  const type = raw.split(';')[0]?.trim().toLowerCase() || null;
  const m = /;\s*report-type\s*=\s*"?([^";\s]+)"?/i.exec(raw);
  return { type, reportType: m ? m[1]!.toLowerCase() : null };
}

function stripAddressType(value: string): string {
  // "rfc822; Gone@Target.example" / "rfc822;<x@y>" → "gone@target.example"
  const afterType = value.includes(';') ? value.slice(value.indexOf(';') + 1) : value;
  return afterType.trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

const MAX_DIAGNOSTIC_LEN = 500;

function parseDeliveryStatus(text: string): {
  recipients: DsnRecipient[];
  originalMessageId: string | null;
} {
  const blocks = parseHeaderBlocks(text);
  const recipients: DsnRecipient[] = [];
  let originalMessageId: string | null = null;
  for (const block of blocks) {
    // Not RFC 3464, but some MTAs (and gateways) report it.
    const omid = block.get('original-message-id') ?? block.get('x-original-message-id');
    if (omid && !originalMessageId) originalMessageId = omid.trim();
    const final = block.get('final-recipient') ?? block.get('original-recipient');
    if (!final) continue;
    const diagnostic = block.get('diagnostic-code') ?? null;
    recipients.push({
      final_recipient: stripAddressType(final),
      action: block.get('action')?.trim().toLowerCase() ?? null,
      status: block.get('status')?.trim() ?? null,
      diagnostic_code: diagnostic ? diagnostic.slice(0, MAX_DIAGNOSTIC_LEN) : null,
    });
  }
  return { recipients, originalMessageId };
}

function messageIdFromHeaders(text: string): string | null {
  const first = parseHeaderBlocks(text)[0];
  const id = first?.get('message-id');
  return id ? id.trim() : null;
}

function partText(part: RelevancePart): string {
  return typeof part.content === 'string' ? part.content : part.content.toString('utf8');
}

const DELIVERY_STATUS_TYPES = new Set(['message/delivery-status', 'message/global-delivery-status']);
const RETURNED_MESSAGE_TYPES = new Set(['message/rfc822', 'message/global']);
const RETURNED_HEADERS_TYPES = new Set(['text/rfc822-headers', 'message/global-headers']);

/** The text of the first delivery-status part, if any (for the body view). */
export function deliveryStatusText(parts: ReadonlyArray<RelevancePart>): string | null {
  const part = parts.find((p) => DELIVERY_STATUS_TYPES.has(p.contentType.toLowerCase()));
  return part ? partText(part).trim() : null;
}

function parseDsn(parts: ReadonlyArray<RelevancePart>): DsnReport {
  let recipients: DsnRecipient[] = [];
  let originalMessageId: string | null = null;
  let source: DsnReport['original_message_id_source'] = null;
  for (const part of parts) {
    if (!DELIVERY_STATUS_TYPES.has(part.contentType.toLowerCase())) continue;
    const parsed = parseDeliveryStatus(partText(part));
    recipients = recipients.concat(parsed.recipients);
    if (parsed.originalMessageId && !originalMessageId) {
      originalMessageId = parsed.originalMessageId;
      source = 'delivery_status';
    }
  }
  if (!originalMessageId) {
    for (const part of parts) {
      const type = part.contentType.toLowerCase();
      const isMessage = RETURNED_MESSAGE_TYPES.has(type);
      if (!isMessage && !RETURNED_HEADERS_TYPES.has(type)) continue;
      const id = messageIdFromHeaders(partText(part));
      if (id) {
        originalMessageId = id;
        source = isMessage ? 'message_rfc822' : 'rfc822_headers';
        break;
      }
    }
  }
  return {
    recipients,
    original_message_id: originalMessageId,
    original_message_id_source: source,
  };
}

/**
 * Relevance signals from a message's headers — the JSON-safe header record
 * written at parse time ({ 'list-unsubscribe': '<…>', … }) or a legacy
 * stored record (mailparser keys, structured values String()-ified, List-*
 * folded into one 'list' key). At parse time pass the body parts too, so a
 * DSN's delivery-status block and returned-message headers are read.
 */
export function extractRelevanceSignals(input: {
  headers: Readonly<Record<string, unknown>> | null | undefined;
  fromAddress: string;
  parts?: ReadonlyArray<RelevancePart>;
  source: InboundRelevanceSignals['source'];
}): InboundRelevanceSignals {
  const headers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;
  const keys = Object.keys(headers);
  const get = (k: string) => headerString(headers[k]);

  const listId = get('list-id');
  const listUnsubscribe = 'list-unsubscribe' in headers;
  const listHeaders = keys.some((k) => k === 'list' || k.startsWith('list-'));
  const precedence = get('precedence')?.trim().toLowerCase() || null;
  const autoSubmitted = get('auto-submitted')?.split(';')[0]?.trim().toLowerCase() || null;
  const xAutoreply = keys.some((k) => AUTOREPLY_HEADERS.has(k));
  const xars = get('x-auto-response-suppress')?.trim() || null;
  const espMarkers = keys
    .filter((k) => ESP_MARKER_PATTERNS.some((re) => re.test(k)))
    .sort();
  const ct = parseContentType(get('content-type'));
  const parts = input.parts ?? [];
  // Delivery reports only — a read receipt (report-type=disposition-
  // notification) is not a bounce; autoReplyMarkers() covers it.
  const isReport =
    (ct.type === 'multipart/report' && ct.reportType === 'delivery-status') ||
    parts.some((p) => DELIVERY_STATUS_TYPES.has(p.contentType.toLowerCase()));

  return {
    source: input.source,
    list_id: listId ? listId.trim() : null,
    list_unsubscribe: listUnsubscribe,
    list_headers: listHeaders,
    precedence,
    auto_submitted: autoSubmitted,
    x_autoreply: xAutoreply,
    x_auto_response_suppress: xars,
    esp_markers: Array.from(new Set(espMarkers)),
    content_type: ct.type,
    report_type: ct.reportType,
    sender_role: senderRoleOf(input.fromAddress),
    dsn: isReport && parts.length > 0 ? parseDsn(parts) : null,
  };
}

// ---- the decision ----------------------------------------------------

/** True for delivery-status notifications and other system-sender mail
 *  (mailer-daemon / postmaster): never a prospect, at most a bounce. */
export function isDeliveryReport(s: InboundRelevanceSignals): boolean {
  return (
    s.dsn !== null ||
    (s.content_type === 'multipart/report' && s.report_type === 'delivery-status') ||
    s.sender_role === 'mailer_daemon' ||
    s.sender_role === 'postmaster'
  );
}

/** Markers of a machine-sent answer (vacation / OOF responders). */
export function autoReplyMarkers(s: InboundRelevanceSignals): string[] {
  const out: string[] = [];
  if (s.auto_submitted && s.auto_submitted !== 'no') out.push(`auto-submitted:${s.auto_submitted}`);
  if (s.x_autoreply) out.push('x-autoreply');
  if (s.precedence && ['bulk', 'junk', 'list', 'auto_reply'].includes(s.precedence)) {
    out.push(`precedence:${s.precedence}`);
  }
  // Exchange marks its own OOF / rule replies 'All'; partial values
  // ("OOF, AutoReply") are what bulk senders ask of OUR responders.
  if (s.x_auto_response_suppress && /(^|[\s,])all($|[\s,])/i.test(s.x_auto_response_suppress)) {
    out.push('x-auto-response-suppress:all');
  }
  // Read receipts and other non-delivery reports.
  if (s.content_type === 'multipart/report' && s.report_type !== 'delivery-status') {
    out.push(`report:${s.report_type ?? 'unknown'}`);
  }
  return out;
}

/** Markers of list / campaign / machine mail. */
export function bulkSignals(s: InboundRelevanceSignals): string[] {
  const out: string[] = [];
  if (s.list_id) out.push('list-id');
  if (s.list_unsubscribe) out.push('list-unsubscribe');
  if (s.list_headers && !s.list_id && !s.list_unsubscribe) out.push('list-*');
  if (s.precedence && ['bulk', 'list', 'junk'].includes(s.precedence)) {
    out.push(`precedence:${s.precedence}`);
  }
  for (const m of s.esp_markers) out.push(m);
  if (s.sender_role) out.push(`sender:${s.sender_role}`);
  if (s.auto_submitted && s.auto_submitted !== 'no' && s.auto_submitted !== 'auto-replied') {
    // auto-generated / auto-notified: notifications, not answers.
    out.push(`auto-submitted:${s.auto_submitted}`);
  }
  return out;
}

/**
 * DB-derived facts the decision needs. `null` = not evaluated (the service
 * skips queries whose answer cannot change the verdict); it reads as false.
 */
export interface RelevanceFacts {
  /** In-Reply-To / References contain one of our outbound Message-IDs
   *  (case-insensitive). */
  referencesOurOutbound: boolean | null;
  /** The report's original Message-ID (or a reference) is one of ours, or a
   *  Final-Recipient was mailed by us recently. */
  dsnMatchesOurOutbound: boolean | null;
  /** Sender is the contact address of a qualified lead AND we have sent
   *  mail to that address. */
  senderIsContactedLead: boolean | null;
  /** Sender is one of this workspace's own mailbox addresses. */
  senderIsOwnMailbox: boolean | null;
}

export interface RelevanceVerdict {
  relevance: OutreachRelevance;
  /** Plain-language reason for the audit trail / evidence. */
  reason: string;
}

/**
 * The relevance decision, in order:
 *  1. a delivery report is a bounce when it is about our mail, otherwise
 *     unrelated;
 *  2. mail from our own mailbox is unrelated (never suppress ourselves);
 *  3. a reference to our outbound is a prospect reply — an auto reply when
 *     auto markers are present;
 *  4. mail from a contacted lead's address with no bulk signals is a
 *     prospect reply (auto reply with auto markers);
 *  5. bulk signals make it bulk;
 *  6. everything else is unrelated.
 */
export function classifyInboundRelevance(
  signals: InboundRelevanceSignals,
  facts: RelevanceFacts,
): RelevanceVerdict {
  if (isDeliveryReport(signals)) {
    return facts.dsnMatchesOurOutbound
      ? { relevance: 'bounce', reason: 'delivery report about mail we sent' }
      : { relevance: 'unrelated', reason: 'delivery report about mail we did not send' };
  }
  if (facts.senderIsOwnMailbox) {
    return { relevance: 'unrelated', reason: 'sent from one of our own mailboxes' };
  }
  const auto = autoReplyMarkers(signals);
  if (facts.referencesOurOutbound) {
    return auto.length > 0
      ? { relevance: 'auto_reply', reason: `answers our outbound; auto markers: ${auto.join(', ')}` }
      : { relevance: 'prospect_reply', reason: 'answers our outbound (In-Reply-To/References)' };
  }
  const bulk = bulkSignals(signals);
  if (facts.senderIsContactedLead && bulk.length === 0) {
    return auto.length > 0
      ? { relevance: 'auto_reply', reason: `from a contacted lead's address; auto markers: ${auto.join(', ')}` }
      : { relevance: 'prospect_reply', reason: "from a contacted lead's address" };
  }
  if (bulk.length > 0) {
    return { relevance: 'bulk', reason: `bulk signals: ${bulk.join(', ')}` };
  }
  return { relevance: 'unrelated', reason: 'no link to our outreach' };
}
