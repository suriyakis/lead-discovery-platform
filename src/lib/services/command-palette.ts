// Step D (Cmd-K palette): index source. Returns a small, workspace-
// scoped slice of the high-traffic entities (products, leads,
// mailboxes, recent threads) that the operator typically wants to
// jump to. Capped at ~50 per kind so the wire payload stays small;
// once the index is on the client, fuzzy filtering happens locally.

import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import type { WorkspaceContext } from './context';
import { productProfiles } from '@/lib/db/schema/products';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { mailboxes, mailThreads } from '@/lib/db/schema/mailing';

export interface CommandPaletteEntry {
  kind: 'product' | 'lead' | 'mailbox' | 'thread';
  label: string;
  href: string;
  /** Secondary text under the label (e.g., from address for a mailbox). */
  sub?: string;
}

const PER_KIND_LIMIT = 50;

export async function getCommandPaletteIndex(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<CommandPaletteEntry[]> {
  const ws = ctx.workspaceId;
  const [products, leads, mboxes, threads] = await Promise.all([
    db
      .select({
        id: productProfiles.id,
        name: productProfiles.name,
        active: productProfiles.active,
      })
      .from(productProfiles)
      .where(eq(productProfiles.workspaceId, ws))
      .orderBy(desc(productProfiles.updatedAt))
      .limit(PER_KIND_LIMIT),
    db
      .select({
        id: qualifiedLeads.id,
        contact: qualifiedLeads.contactName,
        contactEmail: qualifiedLeads.contactEmail,
        state: qualifiedLeads.state,
      })
      .from(qualifiedLeads)
      .where(eq(qualifiedLeads.workspaceId, ws))
      .orderBy(desc(qualifiedLeads.updatedAt))
      .limit(PER_KIND_LIMIT),
    db
      .select({
        id: mailboxes.id,
        name: mailboxes.name,
        fromAddress: mailboxes.fromAddress,
        status: mailboxes.status,
      })
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.workspaceId, ws),
        ),
      )
      .orderBy(desc(mailboxes.updatedAt))
      .limit(PER_KIND_LIMIT),
    db
      .select({
        id: mailThreads.id,
        subject: mailThreads.subject,
        lastAt: mailThreads.lastMessageAt,
      })
      .from(mailThreads)
      .where(eq(mailThreads.workspaceId, ws))
      .orderBy(desc(mailThreads.lastMessageAt))
      .limit(PER_KIND_LIMIT),
  ]);

  const out: CommandPaletteEntry[] = [];
  for (const p of products) {
    out.push({
      kind: 'product',
      label: p.name,
      href: `/products/${p.id}`,
      sub: p.active ? 'product' : 'product · archived',
    });
  }
  for (const l of leads) {
    const display = l.contact ?? l.contactEmail ?? `lead #${l.id}`;
    out.push({
      kind: 'lead',
      label: display,
      href: `/pipeline/${l.id}`,
      sub: `lead · ${l.state}`,
    });
  }
  for (const m of mboxes) {
    out.push({
      kind: 'mailbox',
      label: m.name,
      href: `/mailbox/${m.id}`,
      sub: `${m.fromAddress} · ${m.status}`,
    });
  }
  for (const t of threads) {
    out.push({
      kind: 'thread',
      label: t.subject || '(no subject)',
      href: `/communication/${t.id}`,
      sub: t.lastAt ? `thread · ${t.lastAt.toLocaleDateString()}` : 'thread',
    });
  }
  return out;
}
