// The platform handbook — the AI guide's knowledge of how the app works.
// Deterministic in-code text beats RAG here: it's small, versioned with
// the features it describes, and needs no indexing. The guide quotes it,
// so every sentence must describe what the code does TODAY, not what a
// flow is meant to do one day.
//
// Rules for editing (enforced by src/tests/assistant-handbook.test.ts):
//   - In-app paths are written as [/path] (the assistant panel turns them
//     into links). Only static routes that exist under src/app — never a
//     dynamic one such as a lead's own page; say "open it from
//     [/pipeline]" instead. Every sidebar route appears at least once.
//   - Behavioural claims carry a tag such as {H-07}. Each tag needs a test
//     whose name contains "[handbook H-07]" (they live in
//     src/tests/handbook-claims.test.ts). When you change the behaviour,
//     that test fails: update the claim and the test together.
//   - Tags are stripped before the text reaches the model
//     (PLATFORM_HANDBOOK); HANDBOOK_SOURCE keeps them for the tests.
//   - Whatever is broken or missing right now goes under "Known
//     limitations right now", one line per issue, starting with its issue
//     id (I…/X…). Delete the line in the PR that fixes the issue.

import { BRAND_NAME } from '@/lib/brand';

/** Heading of the section that lists what does not work yet. */
export const KNOWN_LIMITATIONS_HEADING = '## Known limitations right now';

export const HANDBOOK_SOURCE = `
# ${BRAND_NAME} — how it works

## Where things are
Daily work: [/inbox] (one approval inbox: Review, Drafts, Replies and
Follow-ups tabs), [/dashboard] (workspace overview), [/onboarding] (the
setup checklist), [/notifications] (the event feed), [/health] (the
weekly workspace health report).
Discovery: [/connectors/engine], [/connectors], [/review], [/leads].
Knowledge base: [/products], [/knowledge], [/documents], [/learning].
Pipeline: [/pipeline], [/contacts].
Outreach: [/drafts], [/communication], [/mailbox], [/mailbox/queue],
[/mailbox/signatures], [/mailbox/suppression], [/mailbox/deliverability],
[/settings/outreach].
Workspace: [/settings/members], [/settings/integrations], [/settings/crm],
[/settings/usage], [/settings/billing], [/settings/audit].
Account: [/settings/account], [/support]. Emergency: [/autopilot].

## The pipeline
1. PRODUCT PROFILES ([/products]) define what you sell: descriptions,
   target sectors, include/exclude keywords, qualification criteria,
   outreach language and per-stage outreach angles. Everything
   downstream reads them. Create one on [/products/new], or let the AI
   draft one from your product page URL or spec PDFs on
   [/products/autofill] (it is created inactive for you to review).
2. CONNECTORS + RECIPES ([/connectors]) run discovery. A recipe holds the
   search queries (written in your language; auto-translated for foreign
   markets), the TARGET COUNTRY and the search Language. Open a connector
   and then one of its runs to see that run's log. The Crawl engine
   ([/connectors/engine]) runs recipes on a schedule with quiet hours.
3. QUALIFICATION: every discovered record is AI-qualified against every
   active product: relevance score, confidence, reasons, and a geography
   verdict. THE GEOGRAPHY GATE IS HARD when the recipe has a target
   country: companies outside it are rejected even with a perfect
   product fit; companies whose location can't be verified go to the
   review queue as needs_review. A recipe WITHOUT a target country has
   no geography gate at all: leads from any country pass review and the
   send-time check. {H-20}
4. REVIEW QUEUE ([/review]): you approve, reject or comment. Approving a
   geo-unverified item confirms it is inside the target country.
   Comments teach the system — lessons are extracted automatically and
   influence future qualification. @mentions (write @user@email) notify
   teammates. Approving does NOT create a pipeline lead, a draft or an
   email: it records your decision and trains the learning memory.
   {H-01} Review items cannot be assigned to a teammate; pipeline leads
   can, on the lead's page. {H-03} When autopilot's auto-approve is on,
   some approvals are made by autopilot, not by a person (see Autopilot).
5. LEADS ([/leads]) lists the relevant matches from discovery, whatever
   their review state (archived ones are hidden). "Promote to pipeline"
   on a lead creates the pipeline lead; it does not need an approval
   first. {H-02}
6. PIPELINE ([/pipeline]): open a lead there to set its contact name and
   CONTACT EMAIL, assign it to a teammate, add notes, set its own
   outreach language and move it through the stages. Nothing fills in
   the contact email for you, and no email can be queued for a lead
   without one. {H-04} Stages, in order: raw_discovered → relevant →
   contacted → replied → contact_identified → qualified → handed_over →
   synced_to_crm; any stage can move to closed, and closing needs a
   close reason (won, lost, no_response, wrong_fit, duplicate, spam,
   other). {H-05} Promoted leads start at relevant. Stages move when you
   move them: sending an email or getting a reply does not advance a
   lead; only reply auto-actions close leads and a CRM push sets
   synced_to_crm. {H-21}
   CONTACTS ([/contacts]) are the people behind your mail threads and
   leads, created automatically from your mail; open one to see its
   threads or to write to it from a mailbox.
7. DRAFTS ([/drafts]) are AI-written per stage: discovery (find the
   right person, no pitching), engagement, pitch (only when the
   recipient asks for detail), closing. A person approves a draft on its
   page — except that autopilot's "generate + enqueue" step writes,
   approves and queues drafts with no human review (see Autopilot).
   Only an APPROVED draft whose pipeline lead has a contact email can be
   queued. {H-04} Hand-approved drafts cannot be queued from the draft
   page yet (see Known limitations, I002).
8. SENDING: queued emails go out from a mailbox after a suppression
   check, a geography re-check, the mailbox's sending policy, the domain
   cooldown and the daily limit. The workspace send caps (daily email
   limit, domain cooldown, send delays) live on [/mailbox/queue]. Each
   mailbox's own limits (max per day and per hour, per recipient domain,
   business window, timezone, weekends and holidays) are on that
   mailbox's page, opened from [/mailbox]. {H-06} A held queue entry
   shows its reason on [/mailbox/queue].
9. TRANSLATION: you write in your language. On a draft you can generate
   the translation and review it side by side; the edited translation is
   exactly what is sent. If you don't, the queue translates the approved
   text automatically at send time (when the recipient's language
   differs from yours), and that version is not reviewed by anyone.
   {H-22} Follow-ups work the same way when you approve them.
10. FOLLOW-UPS are configured on [/settings/outreach] (steps, spacing,
   approval). When one is due it is written by AI and either waits for
   approval on [/communication/follow-ups] (also the Follow-ups tab of
   [/inbox]) or, if you switched approval off, is sent without anyone
   reviewing it. {H-15} Any inbound message on the thread cancels the
   remaining follow-ups. Right now follow-ups are NOT scheduled after a
   cold email, so none are sent for cold outreach (see Known
   limitations, I005). {H-14}

## Replies (/communication)
[/communication] shows every thread with its full history. "Suggest
reply (AI)" on a thread drafts a knowledge-grounded reply for you to
edit and send from the thread. Every inbound message gets one class:
positive, redirect, question, interest, doc_request, negative,
out_of_office, bounce, unsubscribe or irrelevant. {H-17} On a thread
linked to a pipeline lead, and only while "Auto-draft replies" is on,
the next step follows from the class: interest / doc_request → a pitch
draft; question / positive → an engagement draft; redirect → a thank-you
in the thread plus a discovery draft to the person they named (or an
engagement draft asking for their address when none was given);
negative → nothing, unless auto-close-negative is on (it is off);
out_of_office / irrelevant → nothing. Reply auto-actions: an unsubscribe
or bounce puts the sender's address on [/mailbox/suppression] and closes
the linked lead. These auto-actions are always on and there is no
setting to change them yet. {H-18} Counts per class are on
[/mailbox/deliverability].

## Autopilot (/autopilot)
[/autopilot] is for Starter and Pro plans (and billing-exempt
workspaces): without one its switches cannot be turned on, and a lapsed
plan stops the runs. {H-11} It runs every 5 minutes and right after
every discovery run that found records, but only while its master switch
is on and its emergency pause is off. {H-12} Every step is off until an
admin turns it on:
- Sync inbound mail.
- Auto-approve: review items still in "new" whose relevance score
  reaches the threshold (default 70) are approved and recorded as
  approved by the workspace owner (or by whoever started the run that
  triggered it), although no person looked at them. needs_review
  (geo-unverified) items are never auto-approved. {H-07}
- Generate + enqueue: for approved items, writes a draft, approves it
  in the workspace owner's name and puts it in the send queue; nobody
  reviews those emails. It still needs a pipeline lead with a contact
  email (see Known limitations, I001). {H-08}
- Auto-drain the send queue, CRM contact sync, CRM deal on qualified.
Per-product overrides (pick a product on [/autopilot]) can switch a step
off for that product or change its threshold. They cannot switch on a
step the workspace has off, and the per-product master and emergency
pause overrides are not applied. {H-13} The Crawl engine page
([/connectors/engine]) repeats the master, auto-approve, threshold and
generate + enqueue switches; they change the same settings as
[/autopilot].

The two pause switches — what each really stops:
- Autopilot "Emergency pause" ([/autopilot]) stops autopilot runs only.
  Emails already in the send queue keep going out. {H-09}
- Send-queue "Emergency pause" ([/mailbox/queue]) stops the send queue
  only. Autopilot keeps writing, approving and queueing drafts. {H-10}
- Neither one stops follow-ups, replies or emails you send by hand,
  crawl schedules, or mailbox sync. A PAUSED mailbox sends nothing and
  is not synced (its queued emails fail instead of waiting); pause one
  with the status switch on its Edit page, opened from [/mailbox].
  {H-23} To stop everything: both pauses, pause every mailbox, and
  switch off the crawl plans on [/connectors/engine].
- The send queue is drained every 30 seconds and mailboxes sync every 2
  minutes whatever autopilot's "Auto-drain" and "Sync inbound" switches
  say; those only add an extra pass inside an autopilot run. Background
  mailbox sync is switched off under "Mailbox auto-sync" on
  [/settings/outreach].

## Mailboxes (/mailbox)
Add one on [/mailbox/new]: SMTP for sending, IMAP for receiving. You need
an active mailbox to send and receive. A mailbox is active, paused (see
above), archived, or failing: after repeated sync failures it is marked
failing and is no longer synced, so replies, bounces and unsubscribes
sent to it go unseen — but it KEEPS SENDING queued emails and
follow-ups. {H-16} To recover, fix its settings on its Edit page and
click Reactivate on the mailbox's page. Send a test email from the
mailbox's page; signatures live on [/mailbox/signatures]; the
suppression list (addresses that are never emailed, checked before
every send) on [/mailbox/suppression].

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
- Questions to this guide are metered AI work too. With an empty wallet
  the guide still answers — free, from a built-in checklist of what it
  can see in the workspace, with a link to [/settings/billing] — and
  questions a platform admin asks inside your workspace are never
  charged to it. {H-24}
- Pro only: actions running on your own API keys (BYOK, set under
  [/settings/integrations]) are token-free.
- Subscriptions and packs are bought on [/settings/billing] (Stripe).

## Knowledge base (/documents, /knowledge)
Upload product docs (text, PDF, DOCX) on [/documents] — they are chunked
and indexed for retrieval AUTOMATICALLY on upload; the reply assistant
and pitch composer ground their answers in these. Ticking products on
the upload form scopes the knowledge to those products (a knowledge
source is created and indexed for you); uploads without products are
available workspace-wide. Byte-identical re-uploads are detected and
skipped; when a file changes, upload the new version. Knowledge sources
created on [/knowledge/new] are also indexed automatically, but editing
a knowledge source's text later does not re-index it: click Re-index on
its page after an edit.
Scanned / image-based PDFs (no text layer) are OCR'd automatically via
Mistral when a Mistral API key is configured (platform-wide by the
admin, or the workspace's own under BYOK) — without a key they fail
with a clear message instead of indexing empty.

## Learning memory (/learning) — the platform teaches itself
Lessons are rules qualification and outreach follow. They come from
four channels: (1) operator review comments, auto-extracted; (2) the
operator's edits to AI drafts — a material rewrite is diffed and
distilled into a style rule (badge "from your edits"); (3) reply
outcomes — a positive reply raises the confidence of the lessons that
shaped the email, a decline lowers it; (4) a weekly AI synthesis pass
that mines the recent decision/reply stream for patterns and proposes
new rules (badge "auto-learned", modest starting confidence). Admins
can trigger "Synthesize now" and "Compact now" on [/learning].
Confidence self-adjusts from outcomes; persistently contradicted
lessons retire automatically. Any lesson can be edited or disabled.
Repeating the same feedback does NOT create duplicate rules — a repeat
is detected (semantically, not just word-for-word) and strengthens the
existing rule's confidence instead, with the new event added to its
evidence chain.

## Settings that matter
- [/settings/integrations]: AI provider (BYOK), Web Search backend
  (Gemini grounding recommended), embeddings, research provider.
- [/settings/outreach]: workspace native language, default outreach
  language, "Auto-draft replies" (AI drafts the next reply on lead
  threads for your review; "Auto-send replies" has no effect yet, so
  reply drafts always wait for you), follow-up schedule and approval,
  mailbox auto-sync, trash retention.
- [/settings/members]: invite teammates and set their roles (admins).
- [/settings/crm]: CRM connections, plus a CSV export of every pipeline
  lead.
- [/settings/usage]: cost breakdown. [/settings/audit]: who changed what
  (admins). [/settings/account]: your name and password.
- [/health]: the weekly health report — empty wallet, missing product
  or mailbox, recipes without a target country, failed runs, review
  backlog, stale drafts, follow-ups awaiting approval, plus an AI review
  of recent conversations. Admins can run it now.

## Contacting a human (/support)
When the assistant can't solve it, [/support] (sidebar → Account →
Support) messages the platform team directly — billing disputes, bugs,
feature requests. Replies arrive on the same page and as a
notification. Available to every member, including viewers.

## Common problems
- "No leads found": check the recipe has queries, the Web Search
  backend on [/settings/integrations] is real (not mock — see Known
  limitations, I073), and the wallet has tokens.
- "Leads from the wrong country": set the recipe's target country.
  Without one there is no geography check at all; with one, mismatches
  are rejected and unverifiable companies go to review.
- "An address was suppressed or a lead closed by itself": reply
  auto-actions (see Replies) — and Known limitations, X1.
- "Draft won't send" — check in this order: (1) is the draft approved?
  (2) does it have a pipeline lead with a contact email (open the lead
  from [/pipeline])? (3) is it really in the queue on [/mailbox/queue]?
  Hand-approved drafts can't be queued from the draft page yet (Known
  limitations, I002). (4) is the send-queue Emergency pause on
  ([/mailbox/queue])? For autopilot drafts also check the master switch
  and the Emergency pause on [/autopilot]. (5) has the daily email limit
  been reached, or is a domain cooldown or the mailbox's business window
  holding it (the queue entry shows why)? (6) is the mailbox paused or
  failing? (7) is the address on [/mailbox/suppression], or did the
  geography re-check block it?
- "Emails in the wrong language": the first of these that is set wins —
  (1) the lead's own language (on the lead's page, opened from
  [/pipeline]); (2) the recipe's Language (on the recipe, under
  [/connectors]); (3) the workspace default outreach language
  ([/settings/outreach]); (4) the product's language ([/products]) —
  note that a product description written in another language can
  override the product's Language field; (5) the workspace native
  language ([/settings/outreach]); otherwise English. {H-19}
  Translations can be reviewed on the draft before it is sent.
- "Everything is paused": check (1) the token wallet on
  [/settings/billing] — an empty wallet pauses discovery, drafting and
  translation; (2) the master switch and the Emergency pause on
  [/autopilot]; (3) the send-queue Emergency pause on [/mailbox/queue];
  (4) each mailbox's status under [/mailbox] — paused or failing.

${KNOWN_LIMITATIONS_HEADING}
- I001: Nothing creates pipeline leads or contact emails automatically. Approving a review item (by hand or by autopilot) does not make it contactable: promote it on [/leads], then set the contact email on the lead's page (opened from [/pipeline]). Autopilot's generate + enqueue fails for a lead without a contact email, leaves an approved draft behind and then skips that lead for good; an admin can free it with "Archive (mark superseded)" on the draft's page so the next run tries again.
- I002: On a draft's page the "Enqueue for send" form disappears once the draft is approved, so a hand-approved draft (cold email or AI reply draft) cannot be queued; only autopilot's generate + enqueue queues drafts today. The only manual route is sending the text yourself (from the thread on [/communication], or from a mailbox's compose page), which skips the queue's caps, cooldowns, business windows and geography re-check.
- I005: Follow-ups are never scheduled after a cold email, so the follow-up cadence set on [/settings/outreach] sends nothing for cold outreach.
- X1: Every message synced from a mailbox's inbox is classified as if it were a reply to your outreach, including newsletters and notifications. An "unsubscribe" or "bounce" match there suppresses that sender (sometimes a colleague or customer) and raises a "replied" notification. Check [/mailbox/suppression] for addresses you never meant to block and lift them.
- I073: If the research provider chosen on [/settings/integrations] (Gemini or Perplexity) has no working key, discovery silently falls back to mock search: leads called "Mock result N" on example-*.test domains, possibly qualified at token cost. The run's log says provider=mock.
- I004: There is no single switch that stops everything: each Emergency pause stops only its own part (see Autopilot), and follow-ups, manual sends, crawl plans and mailbox sync keep running.
- I020: The per-product "Autopilot enabled" and "Emergency pause" overrides on [/autopilot] are saved but not applied.
- I062: Saving the autopilot form on [/connectors/engine] while the Emergency pause is on also switches the autopilot master off; use [/autopilot] instead.
- I063: After a plan lapses, ticking the Emergency pause on [/autopilot] fails unless every other switch is unticked in the same save; the send-queue pause on [/mailbox/queue] always works.
- I095: A failing mailbox keeps sending but is no longer read, and nobody is notified; only its page shows the failing badge.
- I088: Reply classes come from keyword rules, so ordinary replies can be mislabelled (for example "thanks for your email, we are not interested" can count as a bounce), a class cannot be corrected, and the reply auto-actions cannot be configured.
- I019: "Auto-send replies" does nothing yet, and autopilot's "Auto-drain" and "Sync inbound" switches do not control the background drain and sync.
`.trim();

const CLAIM_TAG_RE = /\{(H-\d{2})\}/g;

/** Remove claim tags (and the space before them) for display. */
export function stripClaimTags(text: string): string {
  return text.replace(/ ?\{H-\d{2}\}/g, '');
}

/** What the assistant's model reads: the handbook without claim tags. */
export const PLATFORM_HANDBOOK = stripClaimTags(HANDBOOK_SOURCE);

/** Every claim tag in the handbook, e.g. ["H-01", "H-02", …], deduped. */
export function handbookClaimTags(): string[] {
  const tags = new Set<string>();
  for (const m of HANDBOOK_SOURCE.matchAll(CLAIM_TAG_RE)) tags.add(m[1]!);
  return [...tags].sort();
}
