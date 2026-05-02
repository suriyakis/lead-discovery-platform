// Technical reply assistant. Given a mail thread (specifically the most
// recent inbound message), retrieve relevant document chunks + learning
// lessons, build a structured prompt, and ask the IAIProvider to draft a
// reply. Phase 12 — RAG-grounded reply generation.

import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { mailMessages, mailThreads, type MailMessage } from '@/lib/db/schema/mailing';
import { recordAuditEvent } from './audit';
import { canWrite, type WorkspaceContext } from './context';
import { retrieve, retrieveLessons } from './rag';
import { getAIProvider, type IAIProvider } from '@/lib/ai';
import type { IEmbeddingProvider } from '@/lib/embeddings';

export class ReplyAssistantError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ReplyAssistantError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new ReplyAssistantError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () =>
  new ReplyAssistantError('thread not found', 'not_found');
const invalid = (msg: string) =>
  new ReplyAssistantError(msg, 'invalid_input');

export interface SuggestReplyInput {
  threadId: bigint;
  /** Override the AI provider (test seam). */
  ai?: IAIProvider;
  /** Override the embedder used by retrieve(). */
  embedder?: IEmbeddingProvider;
  /** Top-k retrieval budgets. */
  chunkLimit?: number;
  lessonLimit?: number;
}

export interface ReplySuggestion {
  text: string;
  model: string;
  sources: {
    chunkIds: bigint[];
    lessonIds: bigint[];
  };
}

export async function suggestReply(
  ctx: WorkspaceContext,
  input: SuggestReplyInput,
): Promise<ReplySuggestion> {
  if (!canWrite(ctx)) throw permissionDenied('reply.suggest');

  const thread = await db
    .select()
    .from(mailThreads)
    .where(
      and(
        eq(mailThreads.workspaceId, ctx.workspaceId),
        eq(mailThreads.id, input.threadId),
      ),
    )
    .limit(1);
  if (!thread[0]) throw notFound();

  const messages = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.threadId, input.threadId),
      ),
    )
    .orderBy(asc(mailMessages.createdAt));
  if (messages.length === 0) throw invalid('thread has no messages');

  const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound')
    ?? messages[messages.length - 1]!;
  const queryText = lastInbound.bodyText
    || lastInbound.subject
    || messages.map((m) => m.subject).join(' ');

  const [chunks, lessons] = await Promise.all([
    retrieve(ctx, queryText, {
      limit: input.chunkLimit ?? 6,
      embedder: input.embedder,
    }),
    retrieveLessons(ctx, queryText, {
      limit: input.lessonLimit ?? 4,
      embedder: input.embedder,
    }),
  ]);

  const prompt = buildPrompt(thread[0].subject, lastInbound, chunks, lessons);
  const ai = input.ai ?? getAIProvider();
  const result = await ai.generateText(
    { system: prompt.system, prompt: prompt.user },
    { temperature: 0.3, mockSeed: prompt.mockSeed },
  );

  await recordAuditEvent(ctx, {
    kind: 'reply.suggest',
    entityType: 'mail_thread',
    entityId: input.threadId,
    payload: {
      lastInboundId: lastInbound.id.toString(),
      chunkIds: chunks.map((c) => c.chunk.id.toString()),
      lessonIds: lessons.map((l) => l.lesson.id.toString()),
      model: result.model,
    },
  });

  return {
    text: result.text.trim(),
    model: result.model,
    sources: {
      chunkIds: chunks.map((c) => c.chunk.id),
      lessonIds: lessons.map((l) => l.lesson.id),
    },
  };
}

interface PromptParts {
  system: string;
  user: string;
  mockSeed: string;
}

function buildPrompt(
  subject: string,
  lastMessage: MailMessage,
  chunks: Awaited<ReturnType<typeof retrieve>>,
  lessons: Awaited<ReturnType<typeof retrieveLessons>>,
): PromptParts {
  const system = [
    'You are a technical reply assistant. Draft a concise, accurate reply to',
    'an inbound email using the supplied context chunks. If a fact is not in',
    'the context, say so honestly rather than inventing.',
    'Output the message body only — no subject, no greeting metadata.',
  ].join(' ');

  const lessonLines =
    lessons.length > 0
      ? lessons.map((l, i) => `${i + 1}. [${l.lesson.category}] ${l.lesson.rule}`).join('\n')
      : '(none)';

  const chunkLines =
    chunks.length > 0
      ? chunks
          .map((c, i) => `<chunk id="${c.chunk.id}" similarity="${c.similarity.toFixed(3)}">\n${c.chunk.content}\n</chunk>`)
          .join('\n\n')
      : '(no relevant context found in the workspace knowledge base)';

  const user = [
    `Subject: ${subject}`,
    '',
    `Last inbound from ${lastMessage.fromAddress}:`,
    lastMessage.bodyText ?? '(no plain-text body)',
    '',
    'Workspace guidelines (priority order):',
    lessonLines,
    '',
    'Relevant knowledge chunks:',
    chunkLines,
    '',
    'Compose the reply now.',
  ].join('\n');

  const mockSeed = `reply:${lastMessage.id}:${chunks.map((c) => c.chunk.id).join(',')}`;
  return { system, user, mockSeed };
}
