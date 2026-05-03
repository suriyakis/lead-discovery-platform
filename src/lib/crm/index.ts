// CRM connector abstraction.
//
// Phase 13 ships two adapters:
//   csv:     pseudo-CRM. push() returns the row as an exportable record;
//            the service then writes a CSV blob to IStorage and the UI
//            offers a download link. No credentials, no remote calls.
//   hubspot: real adapter against HubSpot Contacts API. POST creates a
//            new contact; if `externalId` is supplied (set on prior
//            success), PATCH updates it.
//
// All adapters return the same SyncResult shape so the service layer
// stays free of adapter specifics.

import type { ProductProfile } from '@/lib/db/schema/products';
import type { QualifiedLead } from '@/lib/db/schema/pipeline';
import type { MailMessage, MailThread } from '@/lib/db/schema/mailing';

export interface CrmLeadPayload {
  lead: QualifiedLead;
  product: ProductProfile;
  /** Mailbox / source-record info kept simple as a flat record. */
  metadata: Record<string, unknown>;
}

/**
 * Phase 18: a single mail message turned into a CRM "note". Adapters
 * stitch it onto whatever the CRM calls a contact / deal note.
 */
export interface CrmNotePayload {
  /** Contact in the CRM whose timeline gets the note. */
  contactExternalId: string;
  /** Deal id, when present. */
  dealExternalId?: string;
  message: MailMessage;
  thread: MailThread;
}

/**
 * Phase 18: a deal/opportunity created from a qualified lead.
 */
export interface CrmDealPayload {
  lead: QualifiedLead;
  product: ProductProfile;
  contactExternalId: string;
}

export interface SyncResult {
  outcome: 'succeeded' | 'failed' | 'skipped';
  externalId?: string;
  statusCode?: number;
  error?: string;
  payload: Record<string, unknown>;
  response: Record<string, unknown>;
}

export interface CrmConnectionConfig {
  /** Free-form per-adapter settings. */
  config: Record<string, unknown>;
  /** Resolved cleartext credential. Empty for adapters that need none. */
  credential: string | null;
}

export interface ICRMConnector {
  readonly id: string;
  push(input: CrmLeadPayload, prevExternalId: string | null): Promise<SyncResult>;
  /** Phase 18 — POST a mail message as a CRM Note, optional. Adapters that
      can't do notes (e.g. csv) return outcome='skipped'. */
  pushNote?(input: CrmNotePayload): Promise<SyncResult>;
  /** Phase 18 — create a CRM Deal/Opportunity from a qualified lead. */
  pushDeal?(input: CrmDealPayload, prevExternalId: string | null): Promise<SyncResult>;
  testConnection(): Promise<{ ok: boolean; detail?: string }>;
}

// ---- CSV export "connector" -----------------------------------------

export class CsvCrmConnector implements ICRMConnector {
  public readonly id = 'csv';

  async push(input: CrmLeadPayload): Promise<SyncResult> {
    // The CSV connector doesn't push anywhere; it just normalizes the row
    // for the service to bundle into an export file. The service writes
    // the file to IStorage and surfaces the download URL.
    const row = csvRowFor(input);
    return {
      outcome: 'succeeded',
      payload: row,
      response: { exported: true },
    };
  }

  async testConnection() {
    return { ok: true, detail: 'csv adapter is always ready' };
  }
}

// ---- HubSpot adapter -----------------------------------------------

export interface HubspotConfig {
  /** Private-app token (Bearer) — pulled from workspace_secrets. */
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class HubspotCrmConnector implements ICRMConnector {
  public readonly id = 'hubspot';
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: HubspotConfig) {
    this.token = config.token;
    this.baseUrl = config.baseUrl ?? 'https://api.hubapi.com';
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  async push(input: CrmLeadPayload, prevExternalId: string | null): Promise<SyncResult> {
    const body = hubspotBodyFor(input);
    const url = prevExternalId
      ? `${this.baseUrl}/crm/v3/objects/contacts/${encodeURIComponent(prevExternalId)}`
      : `${this.baseUrl}/crm/v3/objects/contacts`;
    const method = prevExternalId ? 'PATCH' : 'POST';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { raw: text.slice(0, 1000) };
    }

    if (!res.ok) {
      return {
        outcome: 'failed',
        statusCode: res.status,
        error: typeof parsed.message === 'string' ? parsed.message : `HTTP ${res.status}`,
        payload: body as Record<string, unknown>,
        response: parsed,
      };
    }

    const externalId = typeof parsed.id === 'string' ? parsed.id : prevExternalId ?? undefined;
    return {
      outcome: 'succeeded',
      externalId,
      statusCode: res.status,
      payload: body as Record<string, unknown>,
      response: parsed,
    };
  }

  async pushNote(input: CrmNotePayload): Promise<SyncResult> {
    const body = {
      properties: {
        hs_timestamp: (input.message.sentAt ?? input.message.receivedAt ?? input.message.createdAt).toISOString(),
        hs_note_body: hubspotNoteBody(input),
      },
      associations: hubspotNoteAssociations(input),
    };
    const res = await this.callApi('POST', '/crm/v3/objects/notes', body);
    if (!res.ok) {
      return {
        outcome: 'failed',
        statusCode: res.status,
        error: typeof res.parsed.message === 'string' ? res.parsed.message : `HTTP ${res.status}`,
        payload: body as Record<string, unknown>,
        response: res.parsed,
      };
    }
    return {
      outcome: 'succeeded',
      externalId: typeof res.parsed.id === 'string' ? res.parsed.id : undefined,
      statusCode: res.status,
      payload: body as Record<string, unknown>,
      response: res.parsed,
    };
  }

  async pushDeal(
    input: CrmDealPayload,
    prevExternalId: string | null,
  ): Promise<SyncResult> {
    const body = {
      properties: {
        dealname: `${input.product.name} — Lead ${input.lead.id}`,
        dealstage: 'qualifiedtobuy',
        pipeline: 'default',
        amount: undefined,
        lead_platform_lead_id: input.lead.id.toString(),
        lead_platform_product: input.product.name,
      },
      associations: [
        {
          to: { id: input.contactExternalId },
          types: [
            { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 },
          ],
        },
      ],
    };
    const url = prevExternalId
      ? `/crm/v3/objects/deals/${encodeURIComponent(prevExternalId)}`
      : '/crm/v3/objects/deals';
    const method = prevExternalId ? 'PATCH' : 'POST';
    const res = await this.callApi(method, url, body);
    if (!res.ok) {
      return {
        outcome: 'failed',
        statusCode: res.status,
        error: typeof res.parsed.message === 'string' ? res.parsed.message : `HTTP ${res.status}`,
        payload: body as Record<string, unknown>,
        response: res.parsed,
      };
    }
    const externalId = typeof res.parsed.id === 'string' ? res.parsed.id : prevExternalId ?? undefined;
    return {
      outcome: 'succeeded',
      externalId,
      statusCode: res.status,
      payload: body as Record<string, unknown>,
      response: res.parsed,
    };
  }

  private async callApi(
    method: string,
    path: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; parsed: Record<string, unknown> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { raw: text.slice(0, 1000) };
    }
    return { ok: res.ok, status: res.status, parsed };
  }

  async testConnection() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(
        `${this.baseUrl}/crm/v3/objects/contacts?limit=1`,
        {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${this.token}` },
        },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, detail: `HTTP ${res.status}: ${detail.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function hubspotNoteBody(input: CrmNotePayload): string {
  const dir = input.message.direction === 'outbound' ? '→ outbound' : '← inbound';
  const subject = input.message.subject || '(no subject)';
  const body = input.message.bodyText ?? '';
  return [
    `<p><strong>${subject}</strong> · ${dir}</p>`,
    `<p>From: ${input.message.fromAddress}</p>`,
    input.message.toAddresses.length > 0
      ? `<p>To: ${input.message.toAddresses.join(', ')}</p>`
      : '',
    `<pre style="white-space:pre-wrap">${body.replace(/[<>&]/g, (c) =>
      c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;',
    )}</pre>`,
  ].join('');
}

function hubspotNoteAssociations(input: CrmNotePayload): unknown[] {
  const out: unknown[] = [
    {
      to: { id: input.contactExternalId },
      types: [
        // 202 = note→contact (HubSpot defined association type id)
        { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 },
      ],
    },
  ];
  if (input.dealExternalId) {
    out.push({
      to: { id: input.dealExternalId },
      types: [
        // 214 = note→deal
        { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 },
      ],
    });
  }
  return out;
}

// ---- factory --------------------------------------------------------

export function createCrmConnector(
  system: string,
  cfg: CrmConnectionConfig,
): ICRMConnector {
  switch (system) {
    case 'csv':
      return new CsvCrmConnector();
    case 'hubspot': {
      const token = (cfg.config.token as string | undefined) ?? cfg.credential;
      if (!token) {
        throw new Error('hubspot connector requires a token (workspace secret)');
      }
      const baseUrl = typeof cfg.config.baseUrl === 'string' ? cfg.config.baseUrl : undefined;
      return new HubspotCrmConnector({ token, baseUrl });
    }
    default:
      throw new Error(`unknown CRM system: ${system}`);
  }
}

// ---- helpers --------------------------------------------------------

export const CSV_COLUMNS = [
  'lead_id',
  'product_name',
  'state',
  'contact_name',
  'contact_email',
  'contact_role',
  'contact_phone',
  'tags',
  'notes',
  'relevant_at',
  'contacted_at',
  'qualified_at',
  'closed_at',
  'close_reason',
  'updated_at',
] as const;

export function csvRowFor(input: CrmLeadPayload): Record<string, string> {
  const { lead, product } = input;
  return {
    lead_id: lead.id.toString(),
    product_name: product.name,
    state: lead.state,
    contact_name: lead.contactName ?? '',
    contact_email: lead.contactEmail ?? '',
    contact_role: lead.contactRole ?? '',
    contact_phone: lead.contactPhone ?? '',
    tags: lead.tags.join(';'),
    notes: lead.notes ?? '',
    relevant_at: lead.relevantAt?.toISOString() ?? '',
    contacted_at: lead.contactedAt?.toISOString() ?? '',
    qualified_at: lead.qualifiedAt?.toISOString() ?? '',
    closed_at: lead.closedAt?.toISOString() ?? '',
    close_reason: lead.closeReason ?? '',
    updated_at: lead.updatedAt.toISOString(),
  };
}

export function rowsToCsv(rows: ReadonlyArray<Record<string, string>>): string {
  const cols = [...CSV_COLUMNS];
  const escape = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const header = cols.join(',');
  const body = rows
    .map((r) => cols.map((c) => escape(r[c] ?? '')).join(','))
    .join('\n');
  return rows.length === 0 ? header : `${header}\n${body}`;
}

function hubspotBodyFor(input: CrmLeadPayload): Record<string, unknown> {
  const { lead, product } = input;
  return {
    properties: {
      email: lead.contactEmail ?? '',
      firstname: (lead.contactName ?? '').split(' ')[0] ?? '',
      lastname: (lead.contactName ?? '').split(' ').slice(1).join(' '),
      jobtitle: lead.contactRole ?? '',
      phone: lead.contactPhone ?? '',
      hs_lead_status: mapStateToHubspotStatus(lead.state),
      // Custom property names — operators map these in HubSpot's settings.
      lead_platform_product: product.name,
      lead_platform_lead_id: lead.id.toString(),
      lead_platform_notes: (lead.notes ?? '').slice(0, 4000),
    },
  };
}

function mapStateToHubspotStatus(state: string): string {
  switch (state) {
    case 'qualified':
    case 'handed_over':
    case 'synced_to_crm':
      return 'IN_PROGRESS';
    case 'closed':
      return 'COMPLETED';
    default:
      return 'NEW';
  }
}
