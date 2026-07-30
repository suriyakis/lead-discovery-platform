// The platform handbook — the AI guide's knowledge of how the app works.
// Deterministic in-code text beats RAG here: it's small, versioned with
// the features it describes, and needs no indexing. Update it when flows
// change; the guide quotes it.

export const PLATFORM_HANDBOOK = `
# Lead Discovery Platform — how it works

## The pipeline
1. PRODUCT PROFILES (/products) define what you sell: descriptions, target
   sectors, include/exclude keywords, qualification criteria, outreach
   language and per-stage outreach angles. Everything downstream reads them.
2. CONNECTORS + RECIPES (/connectors) run discovery. A recipe holds the
   search queries (written in your language; auto-translated for foreign
   markets), the TARGET COUNTRY and the search language. The Crawl engine
   (/connectors/engine) schedules recipes on an interval with quiet hours.
3. Discovered records are AI-QUALIFIED against every active product:
   relevance score, confidence, reasons, and a geography verdict.
   THE GEOGRAPHY GATE IS HARD: companies outside the recipe's target
   country are rejected even with a perfect product fit; companies whose
   location can't be verified are held for human review.
4. REVIEW QUEUE (/review): humans approve/reject. Approving a
   geo-unverified lead confirms it is inside the target country.
   Comments teach the system — lessons are extracted automatically and
   influence future qualification. @mentions (write @user@email) notify
   teammates; items can be assigned.
5. LEADS (/leads) and PIPELINE (/pipeline): approved records become
   qualified leads and move through stages (discovered → relevant →
   contacted → replied → qualified → handed over / synced to CRM).
6. OUTREACH: drafts (/drafts) are AI-composed per stage — discovery
   (find the right person, no pitching), engagement, pitch (only when
   the recipient asks for detail), closing. EVERY draft needs human
   approval before it can be queued for sending. The send queue
   respects business windows, daily caps, domain cooldowns,
   suppression lists, and re-checks geography at dispatch.
7. COMMUNICATION (/communication): threads with full history. Replies
   are auto-classified (interest, referral, decline, unsubscribe) and
   can auto-draft the next stage. The "Suggest reply (AI)" button
   drafts a knowledge-grounded reply for you to edit. Automatic
   FOLLOW-UPS fire when a cold email gets no reply; by default each
   follow-up needs approval (/communication/follow-ups).
8. TRANSLATION: you write in your language; emails are translated to
   the recipient's language, shown side-by-side for review BEFORE
   sending. The edited translation is exactly what is sent.

## Tokens & billing (/settings/billing)
- Tokens are the prepaid currency for ALL metered work: discovery
  search, AI qualification, drafting, reply suggestions, translation.
  1 token ≈ €0.01. New workspaces start with 500 free tokens.
- SUBSCRIPTIONS refill the wallet monthly: Starter €29/mo includes
  3,500 tokens + up to 3 products, 2 mailboxes, autopilot. Pro €99/mo
  includes 13,000 tokens + unlimited products, 10 mailboxes, BYOK,
  priority support. Unused tokens roll over while subscribed. The
  allowance lands when each invoice is PAID (trials run on the welcome
  tokens).
- Without a subscription: 1 product, 1 mailbox, no autopilot, no BYOK —
  but token packs still work for metered usage.
- One-time top-up packs for bursts: Ping €10 → 1,000, Pulse €49 →
  5,500, Deep Dive €199 → 24,000 tokens.
- When the wallet is empty, discovery, drafting and translation PAUSE
  until tokens arrive (pack purchase or the next allowance).
- Pro only: actions running on your own API keys (BYOK, set under
  /settings/integrations) are token-free.
- Subscriptions are managed via Stripe from the same page.

## Knowledge base (/documents, /knowledge)
Upload product docs (text, PDF, DOCX) and index them — the reply
assistant and pitch composer ground their answers in these. Re-index
after replacing a file.

## Learning memory (/learning) — the platform teaches itself
Lessons are rules qualification and outreach follow. They come from
four channels: (1) operator review comments, auto-extracted; (2) the
operator's edits to AI drafts — a material rewrite is diffed and
distilled into a style rule (badge "from your edits"); (3) reply
outcomes — a positive reply raises the confidence of the lessons that
shaped the email, a decline lowers it; (4) a weekly AI synthesis pass
that mines the recent decision/reply stream for patterns and proposes
new rules (badge "auto-learned", modest starting confidence). Admins
can trigger "Synthesize now" and "Compact now" on /learning.
Confidence self-adjusts from outcomes; persistently contradicted
lessons retire automatically. Any lesson can be edited or disabled.
Repeating the same feedback does NOT create duplicate rules — a repeat
is detected (semantically, not just word-for-word) and strengthens the
existing rule's confidence instead, with the new event added to its
evidence chain.

## Settings that matter
- /settings/integrations: AI provider (BYOK), Web Search backend
  (Gemini grounding recommended), embeddings, research provider.
- /settings/outreach: native language, default outreach language,
  follow-up schedule + approval requirement, send caps.
- Mailboxes (/mailbox): SMTP for sending, IMAP for replies. Without an
  active mailbox nothing can be sent.
- /settings/usage: cost breakdown. /notifications: the event feed.

## Contacting a human (/support)
When the assistant can't solve it, /support (sidebar → Account →
Support) messages the platform team directly — billing disputes, bugs,
feature requests. Replies arrive on the same page and as a
notification. Available to every member, including viewers.

## Common problems
- "No leads found": check the recipe has queries + the Web Search
  backend is real (not mock), and the wallet has tokens.
- "Leads from the wrong country": set the recipe's target country; the
  gate then rejects mismatches and holds unverifiable ones for review.
- "Draft won't send": drafts must be APPROVED first; the queue also
  enforces business windows and daily caps, and blocks geo-unverified
  leads whose review item wasn't approved.
- "Emails in the wrong language": set the product's outreach language
  or the per-lead language; translations are shown for review pre-send.
- "Everything is paused": almost always an empty token wallet — top up
  under /settings/billing.
`.trim();
