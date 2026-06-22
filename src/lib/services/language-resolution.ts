// Outbound communication-language resolver (Phase 63).
//
// Decides which language an outbound message to a given lead should be
// written/sent in, via a precedence cascade:
//
//   1. per-lead override   qualified_leads.outreach_language
//   2. discovery recipe    the recipe that found the lead
//                          (connector_recipes.selectors.language, falling
//                          back to the frozen connector_runs.recipe_snapshot)
//   3. product profile     resolveProfileLanguage(product)
//   4. workspace native    getWorkspaceNativeLanguage(ctx)
//   5. 'en'                ultimate fallback
//
// Recipe sits ABOVE product on purpose: an explicit per-campaign language
// choice must win over the product profile's free-text language detection
// (resolveProfileLanguage lets detection beat the explicit field, so a
// product with a Polish description would otherwise hijack a recipe that
// was deliberately set to, say, German).

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  connectorRecipes,
  connectorRuns,
  sourceRecords,
} from '@/lib/db/schema/connectors';
import { productProfiles } from '@/lib/db/schema/products';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { reviewItems } from '@/lib/db/schema/review';
import { isKnownLanguage, resolveProfileLanguage } from '@/lib/i18n/language';
import { translateText } from './translation';
import {
  getWorkspaceNativeLanguage,
  getWorkspaceOutreachLanguage,
} from './workspace';
import type { WorkspaceContext } from './context';

export type OutboundLanguageSource =
  | 'lead'
  | 'recipe'
  | 'workspace_default'
  | 'product'
  | 'workspace'
  | 'default';

export interface ResolvedOutboundLanguage {
  /** Normalised ISO base code to write/send the outbound message in. */
  language: string;
  /** Which cascade tier produced it (for audit/debugging). */
  source: OutboundLanguageSource;
}

/** Normalise to a base, lowercased code and drop anything we don't know. */
function normKnown(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const base = iso.toLowerCase().split('-')[0] ?? null;
  return base && isKnownLanguage(base) ? base : null;
}

/**
 * Resolve the outbound communication language for a lead identified by its
 * (reviewItem, productProfile) pair. Pure read — never writes.
 */
export async function resolveOutboundLanguage(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  input: { reviewItemId: bigint; productProfileId: bigint },
): Promise<ResolvedOutboundLanguage> {
  // 1. Per-lead override.
  const [lead] = await db
    .select({ outreachLanguage: qualifiedLeads.outreachLanguage })
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.reviewItemId, input.reviewItemId),
        eq(qualifiedLeads.productProfileId, input.productProfileId),
      ),
    )
    .limit(1);
  const leadLang = normKnown(lead?.outreachLanguage);
  if (leadLang) return { language: leadLang, source: 'lead' };

  // 2. Recipe language — live recipe selectors, then frozen run snapshot.
  const [rec] = await db
    .select({
      selectors: connectorRecipes.selectors,
      snapshot: connectorRuns.recipeSnapshot,
    })
    .from(reviewItems)
    .innerJoin(sourceRecords, eq(sourceRecords.id, reviewItems.sourceRecordId))
    .leftJoin(connectorRecipes, eq(connectorRecipes.id, sourceRecords.recipeId))
    .leftJoin(connectorRuns, eq(connectorRuns.id, sourceRecords.runId))
    .where(
      and(
        eq(reviewItems.workspaceId, ctx.workspaceId),
        eq(reviewItems.id, input.reviewItemId),
      ),
    )
    .limit(1);
  if (rec) {
    const sel = (rec.selectors ?? {}) as { language?: string | null };
    const snap = (rec.snapshot ?? {}) as { language?: string | null };
    const recipeLang = normKnown(sel.language) ?? normKnown(snap.language);
    if (recipeLang) return { language: recipeLang, source: 'recipe' };
  }

  // 2.5 Workspace default outbound language (set in Settings → Outreach).
  const wsDefault = normKnown(await getWorkspaceOutreachLanguage(ctx));
  if (wsDefault) return { language: wsDefault, source: 'workspace_default' };

  // 3. Product profile language (its own detection cascade).
  const [product] = await db
    .select()
    .from(productProfiles)
    .where(
      and(
        eq(productProfiles.workspaceId, ctx.workspaceId),
        eq(productProfiles.id, input.productProfileId),
      ),
    )
    .limit(1);
  if (product) {
    const productLang = normKnown(resolveProfileLanguage(product));
    if (productLang) return { language: productLang, source: 'product' };
  }

  // 4. Workspace native default.
  const native = normKnown(await getWorkspaceNativeLanguage(ctx));
  if (native) return { language: native, source: 'workspace' };

  // 5. Ultimate fallback.
  return { language: 'en', source: 'default' };
}

/**
 * Result of preparing an outbound message for dispatch under Flow A.
 * `sendText` is what actually goes on the wire (target language);
 * `bodyTextNative` is the operator-approved native reference to persist
 * alongside it.
 */
export interface OutboundDualBody {
  sendText: string;
  bodyTextNative: string;
  /** Subject to send. When a `nativeSubject` is supplied it is translated
   *  to the target language (so the subject isn't left in the native
   *  language under a translated body); undefined when none was passed. */
  sendSubject?: string;
  nativeLanguage: string;
  targetLanguage: string;
  /** False when target === native (no translation happened). */
  translated: boolean;
}

/**
 * Flow A send-time preparation: given a lead's (reviewItem, product) pair
 * and an approved native-language body, resolve the recipient's target
 * language and translate the body into it. When target equals native, this
 * is a no-op (no AI call) and both sides hold the same text.
 *
 * Every lead-aware sender (outreach queue, follow-ups, thread replies)
 * routes through this so the dual-language pair is consistent and the
 * translate-at-send step can never be bypassed.
 */
export async function prepareOutboundDualBody(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  input: {
    reviewItemId: bigint;
    productProfileId: bigint;
    nativeBody: string;
    /** Optional native-language subject. When set and a translation
     *  happens, it is translated to the target language too. */
    nativeSubject?: string | null;
  },
): Promise<OutboundDualBody> {
  const nativeLanguage = await getWorkspaceNativeLanguage(ctx);
  const { language: targetLanguage } = await resolveOutboundLanguage(ctx, {
    reviewItemId: input.reviewItemId,
    productProfileId: input.productProfileId,
  });

  if (targetLanguage === nativeLanguage) {
    return {
      sendText: input.nativeBody,
      bodyTextNative: input.nativeBody,
      sendSubject: input.nativeSubject ?? undefined,
      nativeLanguage,
      targetLanguage,
      translated: false,
    };
  }

  const { translatedText } = await translateText(ctx, {
    text: input.nativeBody,
    targetLanguage,
    sourceLanguageHint: nativeLanguage,
  });

  let sendSubject = input.nativeSubject ?? undefined;
  if (input.nativeSubject && input.nativeSubject.trim()) {
    const subj = await translateText(ctx, {
      text: input.nativeSubject,
      targetLanguage,
      sourceLanguageHint: nativeLanguage,
    });
    sendSubject = subj.translatedText;
  }

  return {
    sendText: translatedText,
    bodyTextNative: input.nativeBody,
    sendSubject,
    nativeLanguage,
    targetLanguage,
    translated: true,
  };
}
