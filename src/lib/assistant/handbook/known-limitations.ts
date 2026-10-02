// What does not work yet, one entry per tracked issue (AP-01, kept as its
// own module by AP-03). The handbook prints them under KNOWN_LIMITATIONS_
// HEADING, and the guide's system prompt tells the model to say so
// plainly when a question touches one. Delete the entry in the PR that
// fixes the issue; src/tests/assistant-handbook.test.ts checks every
// entry names an audit id (I…/X…) and the Phase 0 blockers stay listed
// until fixed. Text follows the narrative's rules: [/path] links, claim
// tags allowed.

/** Heading of the section that lists what does not work yet. */
export const KNOWN_LIMITATIONS_HEADING = '## Known limitations right now';

export interface KnownLimitation {
  /** Audit issue id, e.g. "I001" or "X1". */
  id: string;
  text: string;
}

export const KNOWN_LIMITATIONS: ReadonlyArray<KnownLimitation> = [
  {
    id: 'I001',
    text: `Nothing creates pipeline leads or contact emails automatically. Approving a review item (by hand or by autopilot) does not make it contactable: promote it on [/leads], then set the contact email on the lead's page (opened from [/pipeline]). Autopilot's generate + enqueue skips an approved item until its lead has a contact email (no draft is written for it meanwhile) and picks it up on the next run after you add one. A draft autopilot approved before this fix without being able to queue it still blocks its lead: an admin can free it with "Archive (mark superseded)" on the draft's page so the next run tries again.`,
  },
  {
    id: 'I002',
    text: `On a draft's page the "Enqueue for send" form disappears once the draft is approved, so a hand-approved draft (cold email or AI reply draft) cannot be queued; only autopilot's generate + enqueue queues drafts today. The only manual route is sending the text yourself (from the thread on [/communication], or from a mailbox's compose page), which skips the queue's caps, cooldowns, business windows and geography re-check.`,
  },
  {
    id: 'I005',
    text: `Follow-ups are never scheduled after a cold email, so the follow-up cadence set on [/settings/outreach] sends nothing for cold outreach.`,
  },
  {
    id: 'X1',
    text: `Until Phase 0 every message synced from a mailbox was classified as if it were a reply, so newsletters and notifications raised "replied" notifications and, with the auto-suppress switches on, suppressed their senders (sometimes colleagues or customers) and closed their leads. Now only mail that answers your outreach is classified and can notify or act; everything else is filed on its thread with no class, no notification and no side effect, whatever the switches say. {H-25} Addresses suppressed and contacts created the old way stay until they are cleaned up: check [/mailbox/suppression] and have an admin revoke the ones you never meant to block.`,
  },
  {
    id: 'I073',
    text: `If the research provider chosen on [/settings/integrations] (Gemini or Perplexity) has no working key, discovery silently falls back to mock search: leads called "Mock result N" on example-*.test domains, possibly qualified at token cost. The run's log says provider=mock.`,
  },
  {
    id: 'I088',
    text: `Reply classes come from keyword rules, so ordinary replies can be mislabelled (for example "thanks for your email, we are not interested" can count as a bounce), and a class cannot be corrected.`,
  },
];

/** The section as the handbook prints it. */
export function knownLimitationsSection(
  entries: ReadonlyArray<KnownLimitation> = KNOWN_LIMITATIONS,
): string {
  return [KNOWN_LIMITATIONS_HEADING, ...entries.map((e) => `- ${e.id}: ${e.text}`)].join('\n');
}
