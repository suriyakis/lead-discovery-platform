// What each job runs on for a workspace, and on whose API key — the answer
// the "AI & search" settings page gives a tenant.
//
// Why it exists (26 Nov): every vendor on that page read "not configured"
// for a Simple-setup workspace while discovery, qualification and drafting
// were all ready to run on the platform keys saved in the admin console.
// The page asked only the server env for a platform key; the runtime asks
// the console first. Nobody could tell whether the work would run.
//
// This module answers with the runtime's own cascades, through the same
// resolvers the provider factories call:
//   provider id  workspace setting → console platform default → env
//                selector → auto-detect (resolveActiveProvider)
//   API key      workspace BYOK → console platform key → env platform key
//                (resolveProviderKey's order; existence only, so a revoked
//                key still reads as present)
// One row per job, each mirroring its factory:
//   discovery      getWebSearchProviderForCtx (src/lib/search/web-search.ts):
//                  the workspace's grounding choice when its key exists,
//                  else the Gemini safety net, else the plain search provider
//   qualification  getQualificationProviderForCtx; without a key the
//                  runtime scores with keyword rules (qualification.ts)
//   research       getResearchProviderForCtx (the lead page's Research panel
//                  and the optional research before a draft)
//   first_emails   getStageProvider 'discovery' / 'referral_intro' /
//   replies        'closing' and 'pitch' / 'engagement' (outreach-stage-
//                  models.ts): the tier vendor when it has a key anywhere,
//                  else the default AI provider on its own model
//   drafting       getAIProviderForCtx: follow-ups, suggested replies,
//                  translation, product autofill and the other AI writing
//   knowledge      getVectorStorageProviderForCtx, then (pgvector) the
//                  embedding cascade (retrieval, gated with drafting;
//                  indexing an upload, which waits for tokens, embeds on
//                  that cascade)
//   ocr            getOcrProviderForCtx: Mistral, for scanned PDFs
// A change to one of those cascades must change this file too
// (provider-readiness.test.ts pins the agreement against the factories).
//
// Not every vendor key belongs to a row. VENDOR_FEATURES lists the
// features that call a vendor directly, with no fallback to another
// provider (Suggest with AI on products: Anthropic or OpenAI, whichever
// the operator picks). A vendor is "not needed now" only when neither a
// row nor such a feature uses it (vendorKeyGap).
//
// The wallet: the billing gate (assertTokens / a spendsTokens gate)
// applies whichever key a call runs on, but only where an entry point
// asks for it. WALLET_GATED records, per job, whether its entry points
// do: on an empty wallet a gated job pauses (no_tokens), an ungated one
// would still run — and, on the platform key, still be debited, below
// zero. Since 27 Nov (Jacol: "Recs, but free sends") every job is gated.
// A gated job can still own ungated work on its provider
// (WALLET_UNGATED_PARTS: translating a queued draft or an approved
// follow-up as it is sent, which the platform pays for — never debited);
// the page names it as still running. An ungated job could own gated work
// (WALLET_GATED_PARTS, empty now); the page would name what of it runs
// and what pauses.

import type { ProviderJobState, ProviderKeyGap } from '@/lib/kinds/provider';
import {
  PLATFORM_PROVIDER_KEYS,
  platformKeyForVendor,
} from '@/lib/platform-provider-keys';
import type { WorkspaceContext } from './context';
import { STAGE_TIERS } from './outreach-stage-models';
import type { SuggesterVendor } from './product-angle-suggester';
import {
  getProviderSettings,
  resolveActiveProvider,
  resolvePlatformProvider,
  resolveTieredModel,
  type ResolvedProvider,
} from './provider-settings';
import { hasPlatformSecretKey, hasSecret } from './secrets';
import { getTokenWallet } from './token-ledger';

/** Whose key a call would run on. */
export type KeySource = 'workspace' | 'platform' | 'none';

export interface VendorKeyStatus {
  vendor: string;
  name: string;
  /** This workspace saved its own key (BYOK). */
  workspaceKey: boolean;
  /** The platform has a key for this vendor — saved in the admin console
   *  or set in the server env. Tenants see it as "the platform key". */
  platformKey: boolean;
  /** The key a call would use: the workspace's own wins. */
  effective: KeySource;
}

export type JobId =
  | 'discovery'
  | 'qualification'
  | 'research'
  | 'first_emails'
  | 'replies'
  | 'drafting'
  | 'knowledge'
  | 'ocr';

export type JobState = ProviderJobState;

export interface JobReadiness {
  job: JobId;
  label: string;
  /** One line: what the job does. */
  purpose: string;
  /** What a missing key does to this job, completing "There is no X key —
   *  neither the platform nor this workspace has one, so …". */
  noKeyEffect: string;
  /** Provider id as the cascade resolved it ('anthropic', 'serpapi', 'mock' …). */
  vendor: string;
  vendorName: string;
  /** The model the job runs, when one is configured anywhere; null = the
   *  provider's built-in default. */
  model: string | null;
  /** 'not_needed' for a provider without an API key (the mock). */
  key: KeySource | 'not_needed';
  /** The job's entry points refuse new work on an empty wallet
   *  (WALLET_GATED). An ungated job still runs with no tokens left. */
  walletGated: boolean;
  /** Work on this gated job's provider whose entry points check no wallet
   *  (WALLET_UNGATED_PARTS): it still runs while the job pauses. `short`
   *  fits a list; `parts` names every such entry point, and `detail` is
   *  them in one sentence; `note` (or null) names where the same controls
   *  do need tokens. `platformPaid`: the platform pays for it — logged,
   *  never debited (AIGenOptions.platformPaid). `billedFromTokens`: a call
   *  made now is debited — the job's own answer, false when platform-paid.
   *  Null: none. */
  ungatedPart: {
    short: string;
    parts: readonly string[];
    detail: string;
    note: string | null;
    platformPaid: boolean;
    billedFromTokens: boolean;
  } | null;
  /** The mirror of ungatedPart, for an UNGATED job: part of its work sits
   *  behind an entry point that does check the wallet
   *  (WALLET_GATED_PARTS). On an empty wallet `running` (what still runs,
   *  "the Research panel on a lead") still runs, and `paused` (a clause,
   *  "the research before a draft pauses with drafting") pauses. Null:
   *  the whole job still runs. */
  gatedPart: { running: string; paused: string } | null;
  /** Usage of this job on the vendor's PLATFORM key is debited from the
   *  token balance — whichever key it runs on now (a section intro
   *  describes the platform key even while the workspace's own runs).
   *  True for every job on a real vendor — a console key and the env var
   *  alike, since every adapter logs resolveProviderKey's source — except
   *  knowledge retrieval (KNOWLEDGE_RETRIEVAL_DEBITED). */
  platformKeyDebited: boolean;
  /** A call made now is debited from the token balance: the platform key
   *  and platformKeyDebited. False on the workspace's own key (the vendor
   *  bills it). */
  billedFromTokens: boolean;
  state: JobState;
}

/**
 * A feature outside the job rows that calls a vendor directly, on that
 * vendor's key, with no fallback to another provider.
 */
export interface VendorFeature {
  id: string;
  label: string;
  /** The model it offers on each vendor it can call, in its own order. */
  models: Readonly<Record<string, string>>;
  /** Its entry point refuses new work on an empty wallet. */
  walletGated: boolean;
  /** Its usage on a vendor's PLATFORM key is debited from the tokens. */
  platformKeyDebited: boolean;
}

/**
 * product-angle-suggester.ts: "Suggest with AI" on a product's angle
 * fields calls getAIProviderById for the vendor the operator picks in
 * products/_suggest-button.tsx (Opus 4.7 or GPT-5) and fails with no_key
 * when that vendor has none — it never falls back like getStageProvider.
 * `satisfies` fails typecheck when the suggester gains or loses a vendor.
 * Wallet: the products page's suggestAngle → suggestStageAngle refuses on
 * an empty wallet (assertTokens, 27 Nov), and getAIProviderById meters
 * with the key's source (metered(…, resolved.source)), so on the platform
 * key it is debited.
 */
export const VENDOR_FEATURES: ReadonlyArray<VendorFeature> = [
  {
    id: 'suggest_angles',
    label: 'Suggest with AI on products',
    models: { anthropic: 'Opus 4.7', openai: 'GPT-5' } satisfies Record<SuggesterVendor, string>,
    walletGated: true,
    platformKeyDebited: true,
  },
];

export interface FeatureReadiness {
  id: string;
  label: string;
  walletGated: boolean;
  platformKeyDebited: boolean;
  /** Each vendor it can call, its model there, and whose key a call to it
   *  would run on ('none': no key — that vendor is out). */
  vendors: Array<{ vendor: string; model: string; key: KeySource; hasKey: boolean }>;
}

export interface ProviderReadiness {
  jobs: JobReadiness[];
  /** Every vendor the platform knows a key for, in display order. */
  vendors: VendorKeyStatus[];
  /** VENDOR_FEATURES with their keys. */
  features: FeatureReadiness[];
  /** `empty`: the balance is spent and the workspace is not billing-exempt
   *  — wallet-gated jobs pause. */
  wallet: { balance: bigint; billingExempt: boolean; empty: boolean };
  /** Every job is ready. */
  allReady: boolean;
  /** The Web Search control's "active" caption: the discovery vendor and
   *  where that choice came from. */
  discoveryChoice: ResolvedProvider;
  /** What discovery runs on when the workspace picks no Web Search
   *  provider — the control's "platform default" option. */
  discoveryPlatformDefault: string;
}

const JOB_COPY: Record<JobId, { label: string; purpose: string; noKeyEffect: string }> = {
  discovery: {
    label: 'Discovery',
    purpose: 'Searches the web for companies that match your products.',
    noKeyEffect: 'so discovery fails when it starts',
  },
  qualification: {
    label: 'Qualification',
    purpose: 'Reads each company found and scores how well it fits.',
    // Not reached: without a key qualification is rules_only.
    noKeyEffect: 'so companies are scored with keyword rules only',
  },
  research: {
    label: 'Lead research',
    purpose:
      'Looks a lead up on the web: the Research panel on a lead, and the optional research before a draft.',
    // outreach.ts: the pre-draft research is best-effort — a draft that is
    // written goes on without it. Not "drafts are still written": on an
    // empty wallet no draft is.
    noKeyEffect: 'so lead research fails; a draft skips the research rather than failing',
  },
  first_emails: {
    label: 'First emails',
    purpose:
      'Writes the first email to each lead, closing notes, and introductions to a referred contact.',
    noKeyEffect: 'so these emails are not written',
  },
  replies: {
    label: 'Replies to leads',
    purpose: 'Writes the pitch and the answers once a lead replies.',
    noKeyEffect: 'so these replies are not written',
  },
  drafting: {
    label: 'Follow-ups and other writing',
    purpose:
      'Writes follow-up emails and suggested replies, translates, and fills in product details.',
    noKeyEffect: 'so this writing fails when it starts',
  },
  knowledge: {
    label: 'Knowledge retrieval',
    purpose: 'Finds the right passages in your product documents for each draft.',
    noKeyEffect: 'so this job fails when it starts',
  },
  ocr: {
    label: 'Reading scanned PDFs',
    purpose: 'Reads PDFs without a text layer that you add as product knowledge.',
    // document-extraction.ts: no OCR provider → "contains no extractable text".
    noKeyEffect: 'so scanned PDFs cannot be read (PDFs with a text layer still can)',
  },
};

// Grounded search and research (research/gemini.ts, research/perplexity.ts)
// need no exception of their own: their factories pass resolveProviderKey's
// source into the adapter, which logs it, so a console key and the env var
// are both the platform's and debited, like every other adapter's. (Until
// 27 Nov the adapters compared the key with the env var instead, and a key
// saved in the admin console was logged as the workspace's own — never
// debited; this module mirrored that comparison.)

/**
 * Knowledge retrieval is never debited. On the OpenAI vector store,
 * OpenAIVectorStorageProvider.query returns its usage and its one caller
 * (buildProductKnowledgeBlock) never records it. On pgvector (and the
 * reply assistant's rag.retrieve) the query embedding is metered by
 * MeteredEmbeddingProvider, whose
 * Math.round(cents) makes a query-sized embed 0 cents — logged, not
 * debited. (Indexing an upload is a separate batch on the same embedding
 * cascade, metered on its own — a large upload is debited — and it waits
 * for tokens on an empty wallet: WALLET_GATED.)
 * Flip this if retrieval starts recording billable usage.
 */
const KNOWLEDGE_RETRIEVAL_DEBITED = false;

/**
 * Does the job's entry point refuse new work on an empty wallet? Traced
 * from the call sites, not assumed — the page says an ungated job still
 * runs.
 */
const WALLET_GATED: Record<JobId, boolean> = {
  // startRun → assertCanStartRun → assertTokens; crawl ticks
  // checkGate('discovery', { spendsTokens }).
  discovery: true,
  // qualification-runs.ts assertTokens / hasTokens; the scoring inside a
  // discovery run sits behind that run's gate.
  qualification: true,
  // researchLead (the Research panel on /pipeline/[id]) assertTokens on a
  // cache miss (27 Nov; a cached answer still loads); the optional
  // research before a draft runs inside generateOutreachDraft, after its
  // assertTokens.
  research: true,
  // generateOutreachDraft assertTokens; closing notes and referral
  // introductions in handleOutreachReply, behind its spendsTokens gate.
  first_emails: true,
  // handleOutreachReply: checkGate('background_ai', { spendsTokens }).
  replies: true,
  // Gated: automatic follow-ups (processDueFollowUps' FOLLOW_UP_GATE, which
  // also covers their send-time translation), suggested replies and
  // /api/translate (assertTokens: "Show translation" / "Re-translate" on
  // a thread reply, CommunicationReply, and on a follow-up awaiting
  // approval, FollowUpApprovalRow), inbound auto-translation
  // (background_ai with spendsTokens), product autofill (assertTokens).
  // Gated 27 Nov (assertTokens; until then they ran and were debited
  // below zero):
  //   - "Show translation" / "Re-translate from draft" on a draft
  //     (drafts/[id]/page.tsx): translateDraftAction →
  //     generateDraftTranslation (outreach.ts)
  //   - "Show translation" / "Re-translate" on a new email (compose
  //     ComposeForm): translateComposeAction
  //   - the signature redesign (/api/signatures/redesign → 402)
  //   - a recipe's search-query translation: saved untranslated on an
  //     empty wallet and translated when its next run starts (startRun,
  //     gated — connector-run.ts translatePendingRecipeQueries)
  // NOT gated, though on this row's provider (translateText /
  // getAIProviderForCtx) — WALLET_UNGATED_PARTS, so the page says it
  // still runs: send-time translation of a queued draft (outreach-queue →
  // prepareOutboundDualBody, under the 'sending' gate without
  // spendsTokens) and of an approved follow-up (approveFollowUp's
  // assertGate('sending') has no spendsTokens either). Both pass
  // platformPaid: logged, never debited.
  // The row stays gated: the writing it names pauses, that part does not.
  drafting: true,
  // Retrieval runs only inside gated drafting: handleOutreachReply's
  // composers and suggestReply (/api/communication/suggest-reply).
  // Indexing an upload on this row's embedding cascade (the
  // knowledge.index job → claimIndexJob) waits on an empty wallet: the
  // row stays queued, noted 'waiting_for_tokens', and resumes after a
  // top-up (27 Nov; until then it ran and was debited below zero).
  knowledge: true,
  // Mistral OCR runs inside knowledge indexing (extractPdfText), which
  // waits for tokens as above; Re-extract with OCR
  // (requestDocumentOcrReextract) assertTokens before queueing (27 Nov).
  ocr: true,
};

/** The ungated work on a gated job's provider (traced in WALLET_GATED's
 *  comments): on an empty wallet the job pauses, this still runs. Each
 *  part names a control as the pages label it, or the work; the handbook
 *  names every part (provider-readiness.test.ts derives that check from
 *  this table). `note` (optional) names where the same controls do need
 *  tokens; `platformPaid`: the platform pays for the part, never debited. */
const WALLET_UNGATED_PARTS: Partial<
  Record<
    JobId,
    { short: string; parts: readonly string[]; note?: string; platformPaid?: boolean }
  >
> = {
  drafting: {
    short: 'translating a queued draft or an approved follow-up as it is sent',
    parts: ['translating a queued draft or an approved follow-up as it is sent'],
    platformPaid: true,
  },
};

/** "A, B, and C" — a part list in one sentence. */
const listParts = (parts: readonly string[]) =>
  new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(parts);

/** The gated work inside an ungated job (traced in WALLET_GATED's
 *  comments): on an empty wallet `running` still runs, `paused` pauses.
 *  Empty since 27 Nov: lead research — the Research panel too — is gated
 *  whole. */
const WALLET_GATED_PARTS: Partial<Record<JobId, { running: string; paused: string }>> = {};

/** The AI factory falls back to the raw AI_MODEL env var for these vendors
 *  only (src/lib/ai/index.ts); DeepSeek runs its built-in default. */
const AI_MODEL_ENV_VENDORS: ReadonlySet<string> = new Set(['openai', 'anthropic', 'gemini']);

/** Display name for a provider id. */
export function vendorDisplayName(vendor: string): string {
  if (vendor === 'mock') return 'Sample data only';
  const spec = PLATFORM_PROVIDER_KEYS.find((p) => p.vendor === vendor);
  return spec?.name ?? vendor;
}

function envHas(envVar: string): boolean {
  return (process.env[envVar]?.trim() ?? '') !== '';
}

/** Key status for every vendor in the platform key catalogue. */
export async function getVendorKeyStatuses(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<VendorKeyStatus[]> {
  return Promise.all(
    PLATFORM_PROVIDER_KEYS.map(async (spec) => {
      const [workspaceKey, consoleKey] = await Promise.all([
        hasSecret(ctx, spec.secretKey),
        hasPlatformSecretKey(spec.secretKey),
      ]);
      const platformKey = consoleKey || envHas(spec.envVar);
      return {
        vendor: spec.vendor,
        name: spec.name,
        workspaceKey,
        platformKey,
        effective: workspaceKey ? 'workspace' : platformKey ? 'platform' : 'none',
      } satisfies VendorKeyStatus;
    }),
  );
}

interface ResolvedJob {
  vendor: string;
  model: string | null;
}

export async function getProviderReadiness(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<ProviderReadiness> {
  const [vendors, settings, wallet] = await Promise.all([
    getVendorKeyStatuses(ctx),
    getProviderSettings(ctx),
    getTokenWallet(ctx),
  ]);
  const byVendor = new Map(vendors.map((v) => [v.vendor, v]));
  const keyFor = (vendor: string): KeySource | 'not_needed' => {
    if (vendor === 'mock' || !platformKeyForVendor(vendor)) return 'not_needed';
    return byVendor.get(vendor)?.effective ?? 'none';
  };
  const hasKey = (vendor: string) => {
    const k = keyFor(vendor);
    return k === 'workspace' || k === 'platform';
  };

  // ---- discovery: getWebSearchProviderForCtx ----
  const research = settings.researchProvider?.trim() || null;
  const explicitSearch = settings.searchProvider?.trim() || null;
  const platformSearch = await resolvePlatformProvider('search', process.env.SEARCH_PROVIDER);
  // The production safety net: a workspace with no Web Search choice gets
  // grounded Gemini (its built-in model) when SEARCH_PROVIDER is unset or
  // mock and a Gemini key exists — the workspace's own or the platform's.
  const safetyNet = (process.env.SEARCH_PROVIDER ?? 'mock') === 'mock' && hasKey('gemini');
  const discoveryPlatformDefault = safetyNet ? 'gemini' : platformSearch.id;
  const { discovery, discoveryChoice } = await (async (): Promise<{
    discovery: ResolvedJob;
    discoveryChoice: ResolvedProvider;
  }> => {
    // The grounding adapter needs its key; without one the runtime falls
    // through to the plain search provider (not the safety net).
    if ((research === 'gemini' || research === 'perplexity') && hasKey(research)) {
      const model = await resolveTieredModel(
        'research',
        research,
        settings.researchModel,
        process.env.RESEARCH_MODEL,
      );
      return {
        discovery: { vendor: research, model: model ?? null },
        discoveryChoice: { id: research, source: 'workspace' },
      };
    }
    if (!research && !explicitSearch && safetyNet) {
      return {
        discovery: { vendor: 'gemini', model: null },
        discoveryChoice: { id: 'gemini', source: 'default' },
      };
    }
    // getSearchProviderForCtx: the workspace's search choice, else the
    // platform tier.
    const active: ResolvedProvider = explicitSearch
      ? { id: explicitSearch, source: 'workspace' }
      : platformSearch;
    return { discovery: { vendor: active.id, model: null }, discoveryChoice: active };
  })();

  // ---- qualification: getQualificationProviderForCtx ----
  const qualificationActive = await resolveActiveProvider(ctx, 'qualification', undefined);
  const qualification: ResolvedJob = {
    vendor: qualificationActive.id,
    model:
      qualificationActive.id === 'mock'
        ? null
        : ((await resolveTieredModel(
            'qualification',
            qualificationActive.id,
            settings.qualificationModel,
            undefined,
          )) ?? null),
  };

  // ---- lead research: getResearchProviderForCtx ----
  const researchActive = await resolveActiveProvider(ctx, 'research', process.env.RESEARCH_PROVIDER);
  const leadResearch: ResolvedJob = {
    vendor: researchActive.id,
    model:
      researchActive.id === 'mock'
        ? null
        : ((await resolveTieredModel(
            'research',
            researchActive.id,
            settings.researchModel,
            process.env.RESEARCH_MODEL,
          )) ?? null),
  };

  // ---- other writing: getAIProviderForCtx ----
  const aiActive = await resolveActiveProvider(ctx, 'ai', process.env.AI_PROVIDER);
  // As the factory: the tiered model, else the raw AI_MODEL env var for the
  // vendors whose branch reads it.
  const drafting: ResolvedJob = {
    vendor: aiActive.id,
    model:
      aiActive.id === 'mock'
        ? null
        : ((await resolveTieredModel('ai', aiActive.id, settings.aiModel, process.env.AI_MODEL)) ??
          (AI_MODEL_ENV_VENDORS.has(aiActive.id) ? process.env.AI_MODEL?.trim() || null : null)),
  };

  // ---- first emails and replies: getStageProvider ----
  // The tier's vendor whenever it has a key anywhere (getAIProviderById);
  // otherwise the default AI provider with its own model (model '').
  const stage = (tier: { vendor: string; model: string }): ResolvedJob =>
    hasKey(tier.vendor) ? { vendor: tier.vendor, model: tier.model } : drafting;
  const firstEmails = stage(STAGE_TIERS.discovery);
  const replies = stage(STAGE_TIERS.pitch);

  // ---- knowledge retrieval: getVectorStorageProviderForCtx ----
  const vectorStorage = await resolveActiveProvider(
    ctx,
    'vector_storage',
    process.env.VECTOR_STORAGE_PROVIDER,
  );
  // getEmbeddingProviderForCtx: pgvector's queries, and every indexing run
  // (runKnowledgeIndexJob embeds the chunks whatever the vector storage).
  const embeddingActive = await resolveActiveProvider(
    ctx,
    'embedding',
    process.env.EMBEDDING_PROVIDER,
  );
  let knowledge: ResolvedJob;
  if (vectorStorage.id === 'mock') {
    knowledge = { vendor: 'mock', model: null };
  } else if (vectorStorage.id === 'openai') {
    // OpenAI file search on the OpenAI key; no embedding model of ours.
    knowledge = { vendor: 'openai', model: null };
  } else {
    // pgvector queries with the embedding provider.
    knowledge = {
      vendor: embeddingActive.id,
      model:
        embeddingActive.id === 'mock' ? null : process.env.EMBEDDING_MODEL?.trim() || null,
    };
  }

  // ---- scanned PDFs: getOcrProviderForCtx (always Mistral) ----
  const ocr: ResolvedJob = {
    vendor: 'mistral',
    model: process.env.MISTRAL_OCR_MODEL?.trim() || null,
  };

  const walletEmpty = !wallet.billingExempt && wallet.balance <= 0n;
  const build = (job: JobId, r: ResolvedJob): JobReadiness => {
    const key = keyFor(r.vendor);
    const walletGated = WALLET_GATED[job];
    let state: JobState;
    if (r.vendor === 'mock') state = 'not_set_up';
    else if (key === 'none') state = job === 'qualification' ? 'rules_only' : 'no_key';
    // Only a job whose entry points check the wallet pauses; the others
    // still run on an empty wallet (WALLET_GATED).
    else if (walletEmpty && walletGated) state = 'no_tokens';
    else state = 'ready';
    const platformKeyDebited =
      r.vendor !== 'mock' && (job === 'knowledge' ? KNOWLEDGE_RETRIEVAL_DEBITED : true);
    const billedFromTokens = key === 'platform' && platformKeyDebited;
    const part = walletGated ? WALLET_UNGATED_PARTS[job] : undefined;
    return {
      job,
      ...JOB_COPY[job],
      vendor: r.vendor,
      vendorName: vendorDisplayName(r.vendor),
      model: r.model,
      key,
      walletGated,
      ungatedPart: part
        ? {
            short: part.short,
            parts: part.parts,
            detail: listParts(part.parts),
            note: part.note ?? null,
            platformPaid: part.platformPaid === true,
            billedFromTokens: part.platformPaid === true ? false : billedFromTokens,
          }
        : null,
      gatedPart: walletGated ? null : (WALLET_GATED_PARTS[job] ?? null),
      platformKeyDebited,
      billedFromTokens,
      state,
    };
  };

  const jobs = [
    build('discovery', discovery),
    build('qualification', qualification),
    build('research', leadResearch),
    build('first_emails', firstEmails),
    build('replies', replies),
    build('drafting', drafting),
    build('knowledge', knowledge),
    build('ocr', ocr),
  ];
  const features: FeatureReadiness[] = VENDOR_FEATURES.map((f) => ({
    id: f.id,
    label: f.label,
    walletGated: f.walletGated,
    platformKeyDebited: f.platformKeyDebited,
    vendors: Object.entries(f.models).map(([vendor, model]) => ({
      vendor,
      model,
      key: byVendor.get(vendor)?.effective ?? 'none',
      hasKey: hasKey(vendor),
    })),
  }));
  return {
    jobs,
    vendors,
    features,
    wallet: { balance: wallet.balance, billingExempt: wallet.billingExempt, empty: walletEmpty },
    allReady: jobs.every((j) => j.state === 'ready'),
    discoveryChoice,
    discoveryPlatformDefault,
  };
}

/**
 * How usage on `vendor`'s PLATFORM key is paid — one answer for the job
 * rows, the provider section's intro and its "Effective key source" line:
 *   none    no job on the vendor would be debited: promise nothing
 *   exempt  a billing-exempt workspace is never charged
 *   tokens  debited from the token balance, except the `free` jobs (whose
 *           platform-key usage is never debited). The exceptions are named
 *           rather than the debited jobs: usage outside the job rows
 *           (Suggest with AI, indexing a large upload) is debited too, so
 *           a list of debited jobs would read as "the rest is free".
 * (The suggester's vendors are the outreach stage tiers' vendors, so a key
 * for either always has a debited job — first emails or replies — and the
 * features need no case of their own here.)
 * It reads platformKeyDebited, so it holds while the workspace's own key
 * runs too (the intro describes the platform key either way).
 */
export type PlatformKeyBilling =
  | { kind: 'none' }
  | { kind: 'exempt' }
  | { kind: 'tokens'; free: JobReadiness[] };

export function platformKeyBilling(
  readiness: Pick<ProviderReadiness, 'jobs' | 'wallet'>,
  vendor: string,
): PlatformKeyBilling {
  const onVendor = readiness.jobs.filter((j) => j.vendor === vendor);
  if (!onVendor.some((j) => j.platformKeyDebited)) return { kind: 'none' };
  if (readiness.wallet.billingExempt) return { kind: 'exempt' };
  return { kind: 'tokens', free: onVendor.filter((j) => !j.platformKeyDebited) };
}

/** A feature that loses a vendor without a key: the model it loses, and
 *  the model it can still use on another vendor (null: none — it stops). */
export interface FeatureKeyGap {
  label: string;
  lost: string;
  fallback: string | null;
}

/** What a vendor without any key does to the work now. */
export interface VendorKeyGap {
  gap: ProviderKeyGap;
  /** Jobs on the vendor that will not run. */
  stopped: JobReadiness[];
  /** Jobs on the vendor that run on keyword rules only. */
  degraded: JobReadiness[];
  /** Features that call the vendor directly. */
  features: FeatureKeyGap[];
}

/**
 * The one answer to "what does the missing `vendor` key affect?" — the
 * Simple list's badge and the Advanced section's NoKeyNote both render
 * it. Null when the vendor has a key (the workspace's own or the
 * platform's). A job that stops is stops_jobs; keyword rules only, or a
 * feature that loses the vendor, is limits_jobs; nothing else is unused.
 */
export function vendorKeyGap(
  readiness: Pick<ProviderReadiness, 'jobs' | 'vendors' | 'features'>,
  vendor: string,
): VendorKeyGap | null {
  const status = readiness.vendors.find((v) => v.vendor === vendor);
  if (!status || status.effective !== 'none') return null;
  const onVendor = readiness.jobs.filter((j) => j.vendor === vendor);
  const stopped = onVendor.filter((j) => j.state === 'no_key');
  const degraded = onVendor.filter((j) => j.state === 'rules_only');
  const features: FeatureKeyGap[] = [];
  for (const f of readiness.features) {
    const own = f.vendors.find((v) => v.vendor === vendor);
    if (!own) continue;
    const other = f.vendors.find((v) => v.vendor !== vendor && v.hasKey);
    features.push({ label: f.label, lost: own.model, fallback: other?.model ?? null });
  }
  const gap: ProviderKeyGap =
    stopped.length > 0
      ? 'stops_jobs'
      : degraded.length > 0 || features.length > 0
        ? 'limits_jobs'
        : 'unused';
  return { gap, stopped, degraded, features };
}

/** What a vendor's key is used for now: the jobs that run on it, and the
 *  features that can call it (VENDOR_FEATURES). */
export function vendorUses(
  readiness: Pick<ProviderReadiness, 'jobs' | 'features'>,
  vendor: string,
): { jobs: JobReadiness[]; features: string[] } {
  return {
    jobs: readiness.jobs.filter((j) => j.vendor === vendor),
    features: readiness.features
      .filter((f) => f.vendors.some((v) => v.vendor === vendor))
      .map((f) => f.label),
  };
}
