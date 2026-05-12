// Pure outreach draft engine.
//
// Two modes:
//   rules:  deterministic template assembled from product fields + record
//           + learning lesson reminders. No I/O, fully testable.
//   ai:     calls IAIProvider with a structured prompt; the engine still
//           runs forbidden-phrase stripping on the output so a misbehaving
//           provider can't smuggle banned phrases past us.
//
// The DB-backed service wraps both with persistence + audit.

import type { ProductProfile } from '@/lib/db/schema/products';
import type { LearningLesson } from '@/lib/db/schema/learning';
import type { OutreachDraftMethod } from '@/lib/db/schema/outreach';
import type { IAIProvider } from '@/lib/ai';
import { getLanguageName, resolveProfileLanguage } from '@/lib/i18n/language';

export interface DraftableRecord {
  title?: string | null;
  snippet?: string | null;
  url?: string | null;
  domain?: string | null;
  body?: string | null;
}

export interface DraftContext {
  channel: string;
  language: string;
}

export interface DraftEvidence {
  promptSystem?: string;
  promptUser?: string;
  matchedLessonIds: bigint[];
  fields: {
    productName: string;
    productLanguage: string;
    recordDomain: string | null;
    recordUrl: string | null;
  };
}

export interface DraftVerdict {
  subject: string | null;
  body: string;
  /** 0..100. Engine self-confidence. */
  confidence: number;
  method: OutreachDraftMethod;
  model: string | null;
  evidence: DraftEvidence;
  /** Forbidden phrases stripped from the output. Empty when clean. */
  forbiddenStripped: string[];
  matchedLessonIds: bigint[];
}

const DEFAULT_GREETING = 'Hello,';
const DEFAULT_SIGNOFF = 'Best regards,';

/**
 * Rules-mode generation. Composes a deterministic template from the
 * product fields + record + lesson hints. Always succeeds; never calls
 * external services. Phase 8's default path.
 */
export function composeRulesDraft(
  record: DraftableRecord,
  product: ProductProfile,
  lessons: ReadonlyArray<LearningLesson>,
  ctx: DraftContext,
): DraftVerdict {
  const recordTitle = (record.title ?? '').trim();
  const recordDomain = (record.domain ?? null);
  const recordUrl = (record.url ?? null);

  const subject = buildSubject(product, recordTitle);
  const matchedLessonIds = lessons.map((l) => l.id);

  const body = buildRulesBody(product, recordTitle, recordDomain, lessons, ctx);
  const stripped = stripForbidden(body, product.forbiddenPhrases);

  // Confidence rises with evidence (non-empty record context, lesson hits).
  const signals =
    (recordTitle ? 1 : 0) +
    (recordDomain ? 1 : 0) +
    (product.outreachInstructions ? 1 : 0) +
    Math.min(lessons.length, 3);
  const confidence = clamp(40 + signals * 8, 30, 90);

  return {
    subject,
    body: stripped.text,
    confidence,
    method: 'rules',
    model: null,
    evidence: {
      promptSystem: undefined,
      promptUser: undefined,
      matchedLessonIds,
      fields: {
        productName: product.name,
        productLanguage: product.language,
        recordDomain,
        recordUrl,
      },
    },
    forbiddenStripped: stripped.removed,
    matchedLessonIds,
  };
}

/**
 * Phase A — discovery-stage email. The first cold message in a new
 * outreach thread. Goal: identify the right contact, NOT pitch the
 * product. The body is short (~60 words), framed as a polite ask
 * ("who handles X for your team?") and references something concrete
 * about the lead (their domain or project title) so it doesn't read
 * as scraped spam.
 *
 * Crucially the AI receives only the product CATEGORY signals
 * (sectors, project types, customer types) — NOT the full product
 * description — so it cannot lapse into pitching. Pitch is a separate
 * stage that runs later, only when the recipient asks for detail.
 */
export async function composeDiscoveryDraft(
  record: DraftableRecord,
  product: ProductProfile,
  ctx: DraftContext,
  ai: IAIProvider,
  modelOverride?: string,
): Promise<DraftVerdict> {
  const prompt = buildDiscoveryPrompt(record, product, ctx);
  const result = await ai.generateText(
    { system: prompt.system, prompt: prompt.user },
    {
      mockSeed: prompt.mockSeed,
      temperature: 0.6,
      ...(modelOverride ? { model: modelOverride } : {}),
    },
  );

  const subject = buildDiscoverySubject(product, (record.title ?? '').trim());
  const body = result.text.trim();
  const stripped = stripForbidden(body, product.forbiddenPhrases);

  return {
    subject,
    body: stripped.text,
    confidence: clamp(70 - stripped.removed.length * 10, 30, 95),
    method: 'ai',
    model: result.model,
    evidence: {
      promptSystem: prompt.system,
      promptUser: prompt.user,
      matchedLessonIds: [],
      fields: {
        productName: product.name,
        productLanguage: product.language,
        recordDomain: record.domain ?? null,
        recordUrl: record.url ?? null,
      },
    },
    forbiddenStripped: stripped.removed,
    matchedLessonIds: [],
  };
}

function buildDiscoverySubject(product: ProductProfile, recordTitle: string): string {
  // Discovery subjects ask for routing, not engagement with the product.
  // Pivot on what the lead does (recordTitle) rather than the product name.
  if (recordTitle) {
    const trimmed = recordTitle.length > 50 ? `${recordTitle.slice(0, 49)}…` : recordTitle;
    return `Who handles ${productCategoryLabel(product)} re: ${trimmed}?`;
  }
  return `Who handles ${productCategoryLabel(product)} on your team?`;
}

function productCategoryLabel(product: ProductProfile): string {
  // A short label the model can route on. Sectors/project types are
  // generally more recognizable to the recipient than the product name.
  const sectors = product.targetSectors[0];
  if (sectors) return sectors;
  const projects = product.targetProjectTypes[0];
  if (projects) return projects;
  return product.name;
}

interface DiscoveryPrompt {
  system: string;
  user: string;
  mockSeed: string;
}

function buildDiscoveryPrompt(
  record: DraftableRecord,
  product: ProductProfile,
  ctx: DraftContext,
): DiscoveryPrompt {
  const effectiveLang =
    (ctx.language && ctx.language.trim()) || resolveProfileLanguage(product);
  const langName = getLanguageName(effectiveLang);

  const forbiddenLines =
    product.forbiddenPhrases.length > 0
      ? `Forbidden phrases (NEVER include any of these): ${product.forbiddenPhrases.join(', ')}`
      : '';

  // Per-stage angle override falls back to the global outreach
  // instructions for backwards compat with profiles that haven't
  // populated the new field yet.
  const angle =
    (product.discoveryAngle ?? product.outreachInstructions ?? '').trim();
  const angleLine = angle ? `Operator angle guidance: ${angle}` : '';

  // Short, contained system prompt. The discovery email is intentionally
  // narrow — the model gets product CATEGORY signals only (sectors /
  // project types / customer types) so it cannot accidentally pitch.
  const system = [
    `You are an outreach assistant writing a SHORT FIRST email in ${langName} (${effectiveLang}).`,
    `Goal: identify the right person at the recipient's organization to talk to about a category of products. NOT to sell.`,
    `Hard rules:`,
    `- Maximum 60 words in the body. Concise wins.`,
    `- Do NOT describe the product. Do NOT name technical features. Do NOT claim benefits.`,
    `- Open with one sentence referencing what the recipient does (use the lead context).`,
    `- The single ask: "could you point me to the right person who handles X?".`,
    `- Polite, direct, no superlatives, no marketing language.`,
    `- Sign off with "Best regards," (no name — the sender layer fills it).`,
    angleLine,
    forbiddenLines,
    `Output only the message body. No subject line.`,
  ]
    .filter(Boolean)
    .join('\n');

  const user = [
    `Lead context:`,
    record.title ? `- What they do / project title: ${record.title}` : '',
    record.domain ? `- Domain: ${record.domain}` : '',
    record.snippet ? `- Snippet: ${record.snippet}` : '',
    '',
    `Product category (USE for routing only — do NOT pitch any of this):`,
    product.targetSectors.length > 0
      ? `- Sectors: ${product.targetSectors.join(', ')}`
      : '',
    product.targetProjectTypes.length > 0
      ? `- Project types: ${product.targetProjectTypes.join(', ')}`
      : '',
    product.targetCustomerTypes.length > 0
      ? `- Buyer roles: ${product.targetCustomerTypes.join(', ')}`
      : '',
    '',
    `Write the discovery email body now.`,
  ]
    .filter(Boolean)
    .join('\n');

  const mockSeed = `discovery:${product.id}:${record.url ?? record.domain ?? 'noref'}`;
  return { system, user, mockSeed };
}

// ─── Phase C composers — in-thread stages ────────────────────────────
//
// engagement / pitch / closing / referral are all in-thread responses
// to an existing conversation. They share a common shape (read the
// thread, decide what to write next) but differ in tone + length +
// what's allowed.

export interface ThreadMessage {
  /** 'inbound' = from the recipient, 'outbound' = our prior send. */
  direction: 'inbound' | 'outbound';
  /** Plain text body — html is converted upstream. */
  body: string;
  /** ISO timestamp for thread ordering. */
  at: string;
  /** Display name for the sender (best-effort). */
  fromName?: string | null;
  fromAddress?: string | null;
}

function renderThreadHistory(thread: ReadonlyArray<ThreadMessage>): string {
  // Newest 6 messages, oldest first. Each block prefixed with direction
  // + sender so the model knows who said what.
  const last = thread.slice(-6);
  return last
    .map((m) => {
      const sender =
        m.direction === 'outbound'
          ? `[us]`
          : `[${m.fromName ?? m.fromAddress ?? 'them'}]`;
      return `${sender}\n${m.body.trim()}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Phase C — engagement reply. The recipient sent a question, gave a
 * non-committal response, or asked for a qualifying detail. Goal:
 * answer concisely and keep the conversation moving toward identifying
 * fit, WITHOUT pitching the product. Pitch only happens when the
 * recipient explicitly asks for product info (composePitchDraft).
 */
export async function composeEngagementDraft(
  thread: ReadonlyArray<ThreadMessage>,
  product: ProductProfile,
  ctx: DraftContext,
  ai: IAIProvider,
  modelOverride?: string,
  productKnowledge?: string | null,
): Promise<DraftVerdict> {
  const prompt = buildEngagementPrompt(thread, product, ctx, productKnowledge ?? null);
  const result = await ai.generateText(
    { system: prompt.system, prompt: prompt.user },
    {
      mockSeed: prompt.mockSeed,
      temperature: 0.6,
      ...(modelOverride ? { model: modelOverride } : {}),
    },
  );
  const subject = lastInboundSubject(thread, product) ?? `Re: ${product.name}`;
  const body = result.text.trim();
  const stripped = stripForbidden(body, product.forbiddenPhrases);
  return {
    subject,
    body: stripped.text,
    confidence: clamp(70 - stripped.removed.length * 10, 30, 95),
    method: 'ai',
    model: result.model,
    evidence: makeEvidence(prompt.system, prompt.user, product, thread),
    forbiddenStripped: stripped.removed,
    matchedLessonIds: [],
  };
}

/**
 * Phase C — pitch draft. The recipient explicitly asked for product
 * detail (matched ReplyClass `doc_request` / strong `interest`). Now
 * the full description, differentiators, and one concrete next step
 * are appropriate. Length budget ~180 words.
 */
export async function composePitchDraft(
  thread: ReadonlyArray<ThreadMessage>,
  product: ProductProfile,
  ctx: DraftContext,
  ai: IAIProvider,
  researchContext: string | null = null,
  modelOverride?: string,
  productKnowledge?: string | null,
): Promise<DraftVerdict> {
  const prompt = buildPitchPrompt(thread, product, ctx, researchContext, productKnowledge ?? null);
  const result = await ai.generateText(
    { system: prompt.system, prompt: prompt.user },
    {
      mockSeed: prompt.mockSeed,
      temperature: 0.5,
      ...(modelOverride ? { model: modelOverride } : {}),
    },
  );
  const subject = lastInboundSubject(thread, product) ?? `${product.name}: details`;
  const body = result.text.trim();
  const stripped = stripForbidden(body, product.forbiddenPhrases);
  return {
    subject,
    body: stripped.text,
    confidence: clamp(70 - stripped.removed.length * 10, 30, 95),
    method: 'ai',
    model: result.model,
    evidence: makeEvidence(prompt.system, prompt.user, product, thread),
    forbiddenStripped: stripped.removed,
    matchedLessonIds: [],
  };
}

/**
 * Phase C — closing draft. Terminal acknowledgement. Used for declines
 * (thanks for the time, polite close) and for the original-thread
 * thank-you when a referral fork happens.
 */
export async function composeClosingDraft(
  thread: ReadonlyArray<ThreadMessage>,
  reason: 'decline' | 'handed_off' | 'qualified',
  product: ProductProfile,
  ctx: DraftContext,
  ai: IAIProvider,
  /** Only set for `handed_off` — the email we're now reaching out to. */
  referralToEmail?: string | null,
  modelOverride?: string,
): Promise<DraftVerdict> {
  const prompt = buildClosingPrompt(thread, reason, product, ctx, referralToEmail ?? null);
  const result = await ai.generateText(
    { system: prompt.system, prompt: prompt.user },
    {
      mockSeed: prompt.mockSeed,
      temperature: 0.4,
      ...(modelOverride ? { model: modelOverride } : {}),
    },
  );
  const subject = lastInboundSubject(thread, product) ?? `Re: ${product.name}`;
  const body = result.text.trim();
  const stripped = stripForbidden(body, product.forbiddenPhrases);
  return {
    subject,
    body: stripped.text,
    confidence: clamp(75 - stripped.removed.length * 10, 30, 95),
    method: 'ai',
    model: result.model,
    evidence: makeEvidence(prompt.system, prompt.user, product, thread),
    forbiddenStripped: stripped.removed,
    matchedLessonIds: [],
  };
}

/**
 * Phase D — referral intro. First email to a freshly-referred contact.
 * Same shape as composeDiscoveryDraft but the prompt mentions WHO
 * referred us and WHY they thought this person was the right contact.
 */
export async function composeReferralIntroDraft(
  record: DraftableRecord,
  product: ProductProfile,
  referral: { fromName?: string | null; fromEmail: string; reason?: string | null },
  ctx: DraftContext,
  ai: IAIProvider,
  modelOverride?: string,
): Promise<DraftVerdict> {
  const prompt = buildReferralIntroPrompt(record, product, referral, ctx);
  const result = await ai.generateText(
    { system: prompt.system, prompt: prompt.user },
    {
      mockSeed: prompt.mockSeed,
      temperature: 0.5,
      ...(modelOverride ? { model: modelOverride } : {}),
    },
  );
  const referrerName =
    referral.fromName ?? referral.fromEmail.split('@')[0] ?? 'a colleague';
  const subject = `Intro from ${referrerName} — ${productCategoryLabel(product)}`;
  const body = result.text.trim();
  const stripped = stripForbidden(body, product.forbiddenPhrases);
  return {
    subject,
    body: stripped.text,
    confidence: clamp(70 - stripped.removed.length * 10, 30, 95),
    method: 'ai',
    model: result.model,
    evidence: makeEvidence(prompt.system, prompt.user, product, []),
    forbiddenStripped: stripped.removed,
    matchedLessonIds: [],
  };
}

// ─── Engagement / pitch / closing / referral prompt builders ─────────

function makeEvidence(
  system: string,
  user: string,
  product: ProductProfile,
  thread: ReadonlyArray<ThreadMessage>,
): DraftEvidence {
  // Last inbound is the most useful for evidence (shows what we replied to)
  const lastInbound = [...thread].reverse().find((m) => m.direction === 'inbound');
  return {
    promptSystem: system,
    promptUser: user,
    matchedLessonIds: [],
    fields: {
      productName: product.name,
      productLanguage: product.language,
      recordDomain: lastInbound?.fromAddress?.split('@')[1] ?? null,
      recordUrl: null,
    },
  };
}

function lastInboundSubject(
  thread: ReadonlyArray<ThreadMessage>,
  product: ProductProfile,
): string | null {
  void thread;
  // Subject is owned by the mail layer (Re: foo), not the engine. The
  // service layer overrides this with the actual thread subject before
  // persisting. We still return a useful default so unit tests assert
  // something meaningful.
  return `Re: ${product.name}`;
}

interface InThreadPrompt {
  system: string;
  user: string;
  mockSeed: string;
}

function buildEngagementPrompt(
  thread: ReadonlyArray<ThreadMessage>,
  product: ProductProfile,
  ctx: DraftContext,
  productKnowledge: string | null,
): InThreadPrompt {
  const effectiveLang =
    (ctx.language && ctx.language.trim()) || resolveProfileLanguage(product);
  const langName = getLanguageName(effectiveLang);
  const forbiddenLines =
    product.forbiddenPhrases.length > 0
      ? `Forbidden phrases (NEVER include): ${product.forbiddenPhrases.join(', ')}`
      : '';
  const angle =
    (product.engagementAngle ?? product.outreachInstructions ?? '').trim();
  const angleLine = angle ? `Operator angle guidance: ${angle}` : '';

  const system = [
    `You are a B2B outreach assistant writing an in-thread reply in ${langName} (${effectiveLang}).`,
    `Goal: respond naturally to the most recent inbound message. Move the conversation toward identifying whether this person (or someone they can name) is the right contact for the product category.`,
    `Hard rules:`,
    `- DO NOT pitch the product. Do not list features or claim benefits.`,
    `- ≤80 words. Match the recipient's tone (formal/casual).`,
    `- If the recipient asked a specific question, answer it directly first, then optionally ONE follow-up.`,
    `- If non-committal, ask ONE specific qualifying question (not "are you interested?" — ask about a real signal: project type, timeline, current vendor).`,
    `- Sign off with "Best regards," (no name).`,
    angleLine,
    forbiddenLines,
    'Output only the message body. No subject line.',
  ]
    .filter(Boolean)
    .join('\n');

  const knowledgeBlock = productKnowledge ? `${productKnowledge}\n\n` : '';

  const user = [
    `Conversation so far (oldest → newest):`,
    renderThreadHistory(thread),
    '',
    knowledgeBlock,
    `Product category (for routing context only — do NOT pitch):`,
    product.targetSectors.length > 0
      ? `- Sectors: ${product.targetSectors.join(', ')}`
      : '',
    product.targetProjectTypes.length > 0
      ? `- Project types: ${product.targetProjectTypes.join(', ')}`
      : '',
    '',
    `Write the in-thread reply now.`,
  ]
    .filter(Boolean)
    .join('\n');

  const mockSeed = `engagement:${product.id}:${thread.length}`;
  return { system, user, mockSeed };
}

function buildPitchPrompt(
  thread: ReadonlyArray<ThreadMessage>,
  product: ProductProfile,
  ctx: DraftContext,
  researchContext: string | null,
  productKnowledge: string | null,
): InThreadPrompt {
  const effectiveLang =
    (ctx.language && ctx.language.trim()) || resolveProfileLanguage(product);
  const langName = getLanguageName(effectiveLang);
  const forbiddenLines =
    product.forbiddenPhrases.length > 0
      ? `Forbidden phrases (NEVER include): ${product.forbiddenPhrases.join(', ')}`
      : '';

  const angle =
    (product.pitchAngle ?? product.outreachInstructions ?? '').trim();
  const angleLine = angle ? `Operator angle guidance: ${angle}` : '';

  const system = [
    `You are a B2B outreach assistant writing a product-detail reply in ${langName} (${effectiveLang}).`,
    `The recipient explicitly asked for product information. Now you may pitch — concisely.`,
    `Hard rules:`,
    `- ≤180 words.`,
    `- Lead with the differentiator most relevant to the recipient's project context (extract from the conversation).`,
    `- One concrete next step at the end (call, datasheet, sample).`,
    `- No superlatives, no "industry-leading", no marketing language.`,
    angleLine,
    product.negativeOutreachInstructions
      ? `Avoid: ${product.negativeOutreachInstructions.trim()}`
      : '',
    forbiddenLines,
    'Output only the message body. No subject line.',
  ]
    .filter(Boolean)
    .join('\n');

  const researchBlock = researchContext
    ? `Research context about the recipient (use to personalize, not as a footnote):\n${researchContext.trim()}\n`
    : '';
  const knowledgeBlock = productKnowledge ? `${productKnowledge}\n` : '';

  const user = [
    `Conversation so far (oldest → newest):`,
    renderThreadHistory(thread),
    '',
    researchBlock,
    knowledgeBlock,
    `Product:`,
    `- Name: ${product.name}`,
    product.shortDescription ? `- Short: ${product.shortDescription.trim()}` : '',
    product.fullDescription ? `- Full: ${product.fullDescription.trim()}` : '',
    product.targetSectors.length > 0
      ? `- Sectors: ${product.targetSectors.join(', ')}`
      : '',
    '',
    `Write the pitch reply now.`,
  ]
    .filter(Boolean)
    .join('\n');

  const mockSeed = `pitch:${product.id}:${thread.length}`;
  return { system, user, mockSeed };
}

function buildClosingPrompt(
  thread: ReadonlyArray<ThreadMessage>,
  reason: 'decline' | 'handed_off' | 'qualified',
  product: ProductProfile,
  ctx: DraftContext,
  referralToEmail: string | null,
): InThreadPrompt {
  const effectiveLang =
    (ctx.language && ctx.language.trim()) || resolveProfileLanguage(product);
  const langName = getLanguageName(effectiveLang);

  const reasonText = {
    decline: 'The recipient declined or said it is not a fit. Send a short, gracious thank-you. Do not push back. Leave the door open without being needy.',
    handed_off: referralToEmail
      ? `The recipient pointed us to ${referralToEmail} as the right contact. Thank them warmly for the referral and confirm we'll follow up there.`
      : `The recipient pointed us to a colleague. Thank them warmly for the referral.`,
    qualified: 'The recipient confirmed they are the right person and gave us go-ahead. Acknowledge briefly and confirm the next step we agreed.',
  }[reason];

  const system = [
    `You are a B2B outreach assistant writing a closing message in ${langName} (${effectiveLang}).`,
    reasonText,
    `Hard rules:`,
    `- ≤40 words.`,
    `- No pitch. No CTA beyond the agreed next step.`,
    `- Sincere, professional, brief.`,
    `- Sign off with "Best regards," (no name).`,
    'Output only the message body. No subject line.',
  ]
    .filter(Boolean)
    .join('\n');

  const user = [
    `Conversation so far (oldest → newest):`,
    renderThreadHistory(thread),
    '',
    `Write the closing message now.`,
  ].join('\n');

  const mockSeed = `closing:${reason}:${product.id}`;
  return { system, user, mockSeed };
}

function buildReferralIntroPrompt(
  record: DraftableRecord,
  product: ProductProfile,
  referral: { fromName?: string | null; fromEmail: string; reason?: string | null },
  ctx: DraftContext,
): InThreadPrompt {
  const effectiveLang =
    (ctx.language && ctx.language.trim()) || resolveProfileLanguage(product);
  const langName = getLanguageName(effectiveLang);
  const forbiddenLines =
    product.forbiddenPhrases.length > 0
      ? `Forbidden phrases (NEVER include): ${product.forbiddenPhrases.join(', ')}`
      : '';

  const referrerName =
    referral.fromName ?? referral.fromEmail.split('@')[0] ?? 'your colleague';

  const system = [
    `You are a B2B outreach assistant writing a SHORT INTRO email in ${langName} (${effectiveLang}).`,
    `You were referred to this person by ${referrerName} (<${referral.fromEmail}>) — they pointed us your way as the right contact for our product category.`,
    `Goal: open the conversation warmly, name the referrer in the FIRST sentence, then ask one specific question to confirm fit.`,
    `Hard rules:`,
    `- ≤80 words.`,
    `- DO NOT pitch the product or list features.`,
    `- Open: "${referrerName} suggested I reach out about ..." — then one sentence about the product CATEGORY (not the product itself).`,
    `- One ask: confirm whether this is the right area for them, or pose a single qualifying question.`,
    `- Sign off with "Best regards," (no name).`,
    forbiddenLines,
    'Output only the message body. No subject line.',
  ]
    .filter(Boolean)
    .join('\n');

  const user = [
    `Recipient context:`,
    record.title ? `- Title / role hint: ${record.title}` : '',
    record.domain ? `- Domain: ${record.domain}` : '',
    '',
    `Product category (for routing only — do NOT pitch):`,
    product.targetSectors.length > 0
      ? `- Sectors: ${product.targetSectors.join(', ')}`
      : '',
    product.targetProjectTypes.length > 0
      ? `- Project types: ${product.targetProjectTypes.join(', ')}`
      : '',
    '',
    referral.reason ? `Why ${referrerName} pointed us here: ${referral.reason}` : '',
    '',
    `Write the intro email body now.`,
  ]
    .filter(Boolean)
    .join('\n');

  const mockSeed = `referral:${product.id}:${referral.fromEmail}`;
  return { system, user, mockSeed };
}

/**
 * AI-mode generation. Builds a structured prompt, calls the provider, and
 * runs forbidden-phrase stripping on the output. Provider failures bubble
 * up — the service layer decides whether to fall back to rules.
 *
 * Phase 46: optional `researchContext` is injected into the prompt as a
 * "Research context" block above the lead/product context, so the model
 * can reference grounded facts about the recipient (recent news,
 * positioning, decision makers) instead of generic openings.
 */
export async function composeAiDraft(
  record: DraftableRecord,
  product: ProductProfile,
  lessons: ReadonlyArray<LearningLesson>,
  ctx: DraftContext,
  ai: IAIProvider,
  researchContext?: string | null,
): Promise<DraftVerdict> {
  const prompt = buildAiPrompt(record, product, lessons, ctx, researchContext ?? null);
  const result = await ai.generateText(
    { system: prompt.system, prompt: prompt.user },
    { mockSeed: prompt.mockSeed, temperature: 0.7 },
  );

  const subject = buildSubject(product, (record.title ?? '').trim());
  const body = result.text.trim();
  const stripped = stripForbidden(body, product.forbiddenPhrases);

  const matchedLessonIds = lessons.map((l) => l.id);
  // AI confidence baseline higher than rules; nudged down per stripped phrase.
  const confidence = clamp(60 - stripped.removed.length * 10, 30, 95);

  return {
    subject,
    body: stripped.text,
    confidence,
    method: 'ai',
    model: result.model,
    evidence: {
      promptSystem: prompt.system,
      promptUser: prompt.user,
      matchedLessonIds,
      fields: {
        productName: product.name,
        productLanguage: product.language,
        recordDomain: record.domain ?? null,
        recordUrl: record.url ?? null,
      },
    },
    forbiddenStripped: stripped.removed,
    matchedLessonIds,
  };
}

// ---- helpers --------------------------------------------------------

function buildSubject(product: ProductProfile, recordTitle: string): string {
  if (recordTitle) {
    const trimmed = recordTitle.length > 60 ? `${recordTitle.slice(0, 59)}…` : recordTitle;
    return `${product.name}: re ${trimmed}`;
  }
  return `${product.name}: introduction`;
}

function buildRulesBody(
  product: ProductProfile,
  recordTitle: string,
  recordDomain: string | null,
  lessons: ReadonlyArray<LearningLesson>,
  ctx: DraftContext,
): string {
  void ctx; // language/channel honored by caller's downstream rendering
  const parts: string[] = [];
  parts.push(DEFAULT_GREETING);
  parts.push('');

  // Lead context — referencing what was found.
  if (recordTitle) {
    const ref = recordDomain ? ` on ${recordDomain}` : '';
    parts.push(`I came across "${recordTitle}"${ref} and thought it might be worth a short conversation.`);
  } else if (recordDomain) {
    parts.push(`I came across ${recordDomain} and thought it might be worth a short conversation.`);
  } else {
    parts.push('I came across your work and thought it might be worth a short conversation.');
  }
  parts.push('');

  // Product positioning.
  if (product.shortDescription) {
    parts.push(product.shortDescription.trim());
    parts.push('');
  } else if (product.fullDescription) {
    const trimmed = product.fullDescription.trim();
    parts.push(trimmed.length > 400 ? `${trimmed.slice(0, 397)}…` : trimmed);
    parts.push('');
  }

  // Don't interpolate product.outreachInstructions here — that field is
  // meta-guidance addressed to an AI ("Open with a project-specific
  // hook…", "Lead with the technical differentiator…"), NOT email body
  // text. Pasting it verbatim made the operator's first cold email
  // read like a brief to a copywriter. The AI mode (composeAiDraft)
  // uses these instructions correctly via the system prompt; the rules
  // mode simply has no way to follow them.

  // Lesson-derived nudges (outreach_style + product_positioning).
  const nudges = lessons
    .filter((l) =>
      l.category === 'outreach_style' ||
      l.category === 'product_positioning' ||
      l.category === 'contact_role',
    )
    .slice(0, 2)
    .map((l) => l.rule.trim())
    .filter(Boolean);
  if (nudges.length > 0) {
    parts.push(nudges.join(' '));
    parts.push('');
  }

  // Soft CTA. The Sending phase will personalize further.
  parts.push('Would a brief call next week make sense, or is there a better way to get in touch?');
  parts.push('');
  parts.push(DEFAULT_SIGNOFF);

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

interface AiPrompt {
  system: string;
  user: string;
  mockSeed: string;
}

function buildAiPrompt(
  record: DraftableRecord,
  product: ProductProfile,
  lessons: ReadonlyArray<LearningLesson>,
  ctx: DraftContext,
  researchContext: string | null,
): AiPrompt {
  const lessonLines = lessons
    .map((l, i) => `${i + 1}. [${l.category}] ${l.rule}`)
    .join('\n');

  const forbiddenLines =
    product.forbiddenPhrases.length > 0
      ? `Forbidden phrases (NEVER include any of these, in any form):\n${product.forbiddenPhrases.map((p) => `- ${p}`).join('\n')}`
      : '';

  // Prefer the caller's language when set, otherwise resolve via the
  // detector cascade (profile description text often beats the explicit
  // `language` field — see resolveProfileLanguage).
  const effectiveLang =
    (ctx.language && ctx.language.trim()) || resolveProfileLanguage(product);
  const langName = getLanguageName(effectiveLang);

  const system = [
    `You are an outreach assistant drafting a ${ctx.channel} in ${langName} (${effectiveLang}). Produce fluent, natural ${langName} that reads as if originally written in ${langName} — preserve any proper nouns and brand names verbatim.`,
    `You write for the product "${product.name}".`,
    product.outreachInstructions ? `Style guidance: ${product.outreachInstructions.trim()}` : '',
    product.negativeOutreachInstructions
      ? `Avoid: ${product.negativeOutreachInstructions.trim()}`
      : '',
    forbiddenLines,
    'Output only the message body. No subject, no greeting metadata.',
  ]
    .filter(Boolean)
    .join('\n');

  const researchBlock = researchContext
    ? `Research context (live web research about the recipient — use these facts to personalize the opener; cite at most one if natural, never as a footnote):\n${researchContext.trim()}\n`
    : '';

  const user = [
    `Lead context:`,
    record.title ? `- Title: ${record.title}` : '',
    record.domain ? `- Domain: ${record.domain}` : '',
    record.url ? `- URL: ${record.url}` : '',
    record.snippet ? `- Snippet: ${record.snippet}` : '',
    '',
    researchBlock,
    `Product:`,
    `- Name: ${product.name}`,
    product.shortDescription ? `- Short: ${product.shortDescription.trim()}` : '',
    product.fullDescription ? `- Full: ${product.fullDescription.trim()}` : '',
    product.targetSectors.length > 0
      ? `- Target sectors: ${product.targetSectors.join(', ')}`
      : '',
    '',
    lessonLines ? `Workspace guidelines (priority order):\n${lessonLines}` : '',
    '',
    'Compose a concise, professional outreach message.',
  ]
    .filter(Boolean)
    .join('\n');

  // Stable mock seed: prompt-bound + product id + research-context hash
  // so an enriched draft is deterministic per (product, record, research)
  // tuple in tests.
  const researchTag = researchContext ? `:r${researchContext.length}` : '';
  const mockSeed = `outreach:${product.id}:${record.url ?? record.domain ?? 'noref'}${researchTag}`;

  return { system, user, mockSeed };
}

interface StripResult {
  text: string;
  removed: string[];
}

function stripForbidden(text: string, phrases: ReadonlyArray<string>): StripResult {
  if (phrases.length === 0 || !text) return { text, removed: [] };
  let out = text;
  const removed: string[] = [];
  for (const raw of phrases) {
    const phrase = raw.trim();
    if (!phrase) continue;
    const re = new RegExp(escapeRegex(phrase), 'gi');
    if (re.test(out)) {
      removed.push(phrase);
      out = out.replace(re, '[redacted]');
    }
  }
  // Clean up double spaces / orphaned punctuation from substitutions.
  out = out.replace(/\s+\[redacted\]/g, ' [redacted]').replace(/[ \t]{2,}/g, ' ');
  return { text: out, removed };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
