// Phase C/D — pure decision tree mapping a reply classification to the
// next outreach action. Takes the existing ReplyClass from
// reply-classifier.ts (heuristic + AI-confirmed) plus the lead's
// current thread state and returns one of:
//
//   none              — nothing to do (out-of-office, irrelevant, etc.)
//   draft             — generate a new outreach_draft at a specific stage
//                       in the SAME thread (engagement / pitch / closing)
//   referral          — fork: closing thank-you in this thread + new
//                       discovery to the extracted email(s)
//   close_and_suppress — terminal: close the lead + add to suppression
//
// The function is pure: input → output. The wiring layer
// (outreach-reply-handler.ts) consumes Action and performs the side
// effects (enqueue draft jobs, write thread state, etc.).

import type { ReplyClass } from './reply-classifier';
import type { OutreachStage } from '@/lib/db/schema/outreach';

export type OutreachAction =
  | { kind: 'none'; reason: string }
  | { kind: 'draft'; stage: OutreachStage; reasoning: string }
  | { kind: 'referral'; targetEmails: string[]; reasoning: string }
  | { kind: 'close_and_suppress'; reason: 'unsubscribe' | 'bounce' | 'decline' };

export interface DecisionInput {
  classification: ReplyClass;
  /** Confidence the classifier assigned, 0-100. */
  confidence: number;
  /** Emails extracted from the body — empty for non-redirect replies. */
  extractedEmails: string[];
  /** Current stage of the conversation; used to avoid loops
   *  (e.g. don't downgrade from pitch back to engagement on a thanks). */
  currentStage: OutreachStage;
}

export function decideOutreachAction(input: DecisionInput): OutreachAction {
  const { classification, extractedEmails, currentStage } = input;

  // Terminal classes — close the lead, add to suppression where right.
  if (classification === 'unsubscribe') {
    return { kind: 'close_and_suppress', reason: 'unsubscribe' };
  }
  if (classification === 'bounce') {
    return { kind: 'close_and_suppress', reason: 'bounce' };
  }
  if (classification === 'negative') {
    return { kind: 'close_and_suppress', reason: 'decline' };
  }

  // Referral: only forks if we actually have an email to fork to.
  // Without an extracted email it's just an FYI redirect — fall back to
  // engagement so the operator can ask "could you share their contact?"
  if (classification === 'redirect') {
    if (extractedEmails.length > 0) {
      return {
        kind: 'referral',
        targetEmails: extractedEmails,
        reasoning: 'classifier=redirect with extracted email(s)',
      };
    }
    return {
      kind: 'draft',
      stage: 'engagement',
      reasoning: 'redirect without contact — ask for their email in-thread',
    };
  }

  // Out of office: don't generate anything; the existing wait_retry
  // suggested-action covers re-attempts at a later date (Phase B's
  // auto-actions handles that separately).
  if (classification === 'out_of_office') {
    return { kind: 'none', reason: 'out_of_office — wait + retry later' };
  }

  // Doc request / strong interest → escalate to pitch stage. Once at
  // pitch, stay at pitch (don't downgrade on a follow-up "thanks").
  if (classification === 'doc_request' || classification === 'interest') {
    return {
      kind: 'draft',
      stage: 'pitch',
      reasoning: `classifier=${classification} — recipient asked for product info`,
    };
  }

  // Question / positive → engagement-stage reply. If we're already at
  // pitch, stay at pitch (the recipient is digging deeper, not stepping
  // back).
  if (classification === 'question' || classification === 'positive') {
    return {
      kind: 'draft',
      stage: currentStage === 'pitch' ? 'pitch' : 'engagement',
      reasoning: `classifier=${classification} — keep conversation moving`,
    };
  }

  // Irrelevant / unknown — let the operator decide. Drafting blind
  // produces noise; better to surface for human review.
  return {
    kind: 'none',
    reason: `classifier=${classification} — needs human review`,
  };
}
