// MOB-02 rules (getFindings' live signals that need no new producer):
// qualification gaps — records no active product ever judged (I077) and
// verdicts the keyword rules made because the AI failed (I025). Both read
// the records still in play: a review item that is new, needs_review or
// approved (a rejected, ignored or archived record no longer matters).

import { and, count, countDistinct, eq, inArray, lt, max } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { productProfiles } from '@/lib/db/schema/products';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewItems } from '@/lib/db/schema/review';
import { formatUtc } from '@/lib/format-utc';
import { hoursBefore, plural } from '../env';
import { fixHref } from '../hrefs';
import { defineRule } from '../rule';
import { notifyEveryDays } from '../types';

/** Review states whose record still matters to qualification. */
export const IN_PLAY_REVIEW_STATES = ['new', 'needs_review', 'approved'] as const;

/**
 * Grace for work in flight: a record that landed (or a product created)
 * within this window may still be being classified.
 */
export const QUALIFY_GRACE_HOURS = 1;

/**
 * I077: records that never got a verdict from an active product. Records
 * found while no product was active never qualify, and creating or
 * activating a product does not re-qualify existing records — so they
 * never reach Leads for it and autopilot never approves them. One finding
 * listing the products with gaps; the fix is "Re-classify all" on
 * Discovery › Schedules.
 *   warning  at least one in-play record lacks a verdict from at least one
 *            active product (both older than the grace hour)
 */
export const recordsUnqualifiedRule = defineRule({
  id: 'records.unqualified',
  owner: 'discovery',
  summary:
    'Records still in play that an active product never qualified (found before it existed, or while no product was active).',
  async evaluate(env) {
    const wsId = env.ctx.workspaceId;
    const settled = hoursBefore(env.now, QUALIFY_GRACE_HOURS);
    const inPlay = and(
      eq(reviewItems.workspaceId, wsId),
      inArray(reviewItems.state, [...IN_PLAY_REVIEW_STATES]),
      lt(reviewItems.createdAt, settled),
    );
    const products = await db
      .select({ id: productProfiles.id, name: productProfiles.name })
      .from(productProfiles)
      .where(
        and(
          eq(productProfiles.workspaceId, wsId),
          eq(productProfiles.active, true),
          lt(productProfiles.createdAt, settled),
        ),
      );
    if (products.length === 0) return []; // products.none says what to do
    const productIds = products.map((p) => p.id);
    const inPlayRecords = db
      .select({ id: reviewItems.sourceRecordId })
      .from(reviewItems)
      .where(inPlay);
    const qualified = and(
      eq(qualifications.workspaceId, wsId),
      inArray(qualifications.productProfileId, productIds),
      inArray(qualifications.sourceRecordId, inPlayRecords),
    );
    const [[total], perProduct, [anyProduct]] = await Promise.all([
      db.select({ n: count() }).from(reviewItems).where(inPlay),
      db
        .select({ productId: qualifications.productProfileId, n: count() })
        .from(qualifications)
        .where(qualified)
        .groupBy(qualifications.productProfileId),
      db
        .select({ n: countDistinct(qualifications.sourceRecordId) })
        .from(qualifications)
        .where(qualified),
    ]);
    const records = Number(total?.n ?? 0);
    if (records === 0) return [];
    const gaps = products
      .map((p) => ({
        name: p.name,
        missing: records - Number(perProduct.find((r) => r.productId === p.id)?.n ?? 0),
      }))
      .filter((g) => g.missing > 0)
      .sort((a, b) => b.missing - a.missing);
    if (gaps.length === 0) return [];
    const neverAny = records - Number(anyProduct?.n ?? 0);
    const worst = gaps[0]!;
    const productList = gaps
      .slice(0, 3)
      .map((g) => `"${g.name}" (${g.missing} of ${records})`)
      .join(', ');
    return [
      {
        code: 'records.unqualified',
        severity: 'warning',
        title:
          neverAny > 0
            ? `${plural(neverAny, 'record was', 'records were')} never qualified`
            : `${plural(worst.missing, 'record was', 'records were')} never qualified for "${worst.name}"`,
        detail:
          `Records found before a product existed (or while none was active) are never qualified ` +
          `against it, so they never reach Leads for that product and autopilot never approves them. ` +
          `Missing verdicts: ${productList}${gaps.length > 3 ? ` and ${gaps.length - 3} more` : ''}. ` +
          'Run "Re-classify all" on Discovery › Schedules (an admin can).',
        facts: {
          recordsInPlay: records,
          neverQualified: neverAny,
          productsWithGaps: gaps.length,
          worstProductMissing: worst.missing,
        },
        href: fixHref.schedules(),
        notify: { policy: notifyEveryDays(30), dedupeKey: 'records.unqualified' },
      },
    ];
  },
});

/**
 * I025: when the AI cannot classify a record (no key, provider down, a
 * schema error), the keyword rules decide with method 'rules_fallback' —
 * and a record with no signals scores the base 50, which is relevant at
 * the default threshold. Nothing else reports it.
 *   warning  some in-play records were marked RELEVANT by the fallback
 *   info     fallback verdicts exist, none relevant
 * Fix: the AI settings (a key, a working provider), then re-classify.
 */
export const rulesFallbackRule = defineRule({
  id: 'qualification.rules_fallback',
  owner: 'discovery',
  summary:
    'Verdicts the keyword rules made because the AI could not classify the record (I025), relevant ones first.',
  async evaluate(env) {
    const wsId = env.ctx.workspaceId;
    const inPlayRecords = db
      .select({ id: reviewItems.sourceRecordId })
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.workspaceId, wsId),
          inArray(reviewItems.state, [...IN_PLAY_REVIEW_STATES]),
        ),
      );
    const activeProducts = db
      .select({ id: productProfiles.id })
      .from(productProfiles)
      .where(and(eq(productProfiles.workspaceId, wsId), eq(productProfiles.active, true)));
    const rows = await db
      .select({
        relevant: qualifications.isRelevant,
        n: count(),
        latest: max(qualifications.updatedAt),
      })
      .from(qualifications)
      .where(
        and(
          eq(qualifications.workspaceId, wsId),
          eq(qualifications.method, 'rules_fallback'),
          inArray(qualifications.productProfileId, activeProducts),
          inArray(qualifications.sourceRecordId, inPlayRecords),
        ),
      )
      .groupBy(qualifications.isRelevant);
    const relevant = Number(rows.find((r) => r.relevant)?.n ?? 0);
    const total = rows.reduce((s, r) => s + Number(r.n), 0);
    if (total === 0) return [];
    const latest = rows
      .map((r) => (r.latest ? new Date(r.latest) : null))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const facts = {
      fallbackVerdicts: total,
      relevantByFallback: relevant,
      latestAt: latest ? latest.toISOString() : null,
    };
    if (relevant > 0) {
      return [
        {
          code: 'qualification.rules_fallback',
          severity: 'warning',
          title: `${plural(relevant, 'record was', 'records were')} marked relevant without the AI`,
          detail:
            `The AI could not classify ${plural(total, 'record')}, so the keyword rules decided` +
            `${latest ? ` (latest ${formatUtc(latest)})` : ''}; ${relevant} came out relevant. A record with ` +
            'no signals scores 50, which passes the default threshold, so these are not real matches. ' +
            'Check the AI provider on AI & search, then re-classify; reject the ones that are not a fit.',
          facts,
          href: fixHref.integrations(),
          notify: { policy: notifyEveryDays(7), dedupeKey: 'qualification.rules_fallback' },
        },
      ];
    }
    return [
      {
        code: 'qualification.rules_fallback',
        severity: 'info',
        title: `${plural(total, 'verdict was', 'verdicts were')} made without the AI`,
        detail:
          `The AI could not classify ${plural(total, 'record')}, so the keyword rules decided` +
          `${latest ? ` (latest ${formatUtc(latest)})` : ''}. None came out relevant, but they were judged ` +
          'on keywords alone; re-classify once the AI provider works (AI & search).',
        facts,
        href: fixHref.integrations(),
      },
    ];
  },
});
