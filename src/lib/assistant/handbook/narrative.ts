// The handbook's narrative — the AI guide's knowledge of how the app
// works, as prose (src/lib/assistant/handbook/; index.ts assembles it).
// Deterministic in-code text beats RAG here: it's small, versioned with
// the features it describes, and needs no indexing. The guide quotes it,
// so every sentence must describe what the code does TODAY, not what a
// flow is meant to do one day.
//
// Facts the code already holds are NOT written here: the "Where things
// are" screens index (the navigation registry), the pipeline stages, the
// reply classes, the language order, the autopilot steps and the billing
// catalogue are generated blocks (./generated.ts), interpolated below, so
// they change with the code. What does not work yet lives in
// ./known-limitations.ts.
//
// Rules for editing (enforced by src/tests/assistant-handbook.test.ts):
//   - In-app paths are written as [/path] (the assistant panel turns them
//     into links). Only static routes that exist under src/app — never a
//     dynamic one such as a lead's own page; say "open it from
//     [/pipeline]" instead.
//   - Behavioural claims carry a tag such as {H-07}. Each tag needs a test
//     whose name contains "[handbook H-07]" (they live in
//     src/tests/handbook-claims.test.ts). When you change the behaviour,
//     that test fails: update the claim and the test together.
//   - Tags are stripped before the text reaches the model
//     (PLATFORM_HANDBOOK); HANDBOOK_SOURCE keeps them for the tests.

import { BRAND_NAME } from '@/lib/brand';
import type { AutopilotStepId } from '@/lib/autopilot/steps';
import type { HandbookBlocks } from './generated';

/**
 * What each autopilot step does, keyed by step (the order and names come
 * from AUTOPILOT_STEPS). An empty note prints the step name alone.
 */
export const AUTOPILOT_STEP_NOTES: Readonly<Record<AutopilotStepId, string>> = {
  auto_approve_projects: `review items still in "new" whose relevance
  score reaches the threshold (default 70, or the product's higher one)
  are approved and recorded as approved by autopilot — no person's name,
  reason "autopilot" — and never teach the learning memory. Items a
  person already gave a verdict on, and needs_review (geo-unverified)
  items, are never auto-approved; an item that fits several products is
  approved once. {H-07}`,
  auto_enqueue_outreach: `for approved items, writes a draft, approves it
  in the workspace owner's name and puts it in the send queue, oldest
  approval first; nobody reviews those emails. It only takes items whose
  pipeline lead has a contact email: the others get no draft and wait
  (the run log counts them as needs_contact; see Known limitations,
  I001). {H-08}`,
  auto_crm_contact_sync: `new and changed qualified leads only; every push
  shows on the lead's timeline.`,
  auto_crm_deal_on_qualified: `only for leads whose contact is already
  synced; every push shows on the lead's timeline.`,
};

/** The narrative, with the generated blocks in place. */
export function handbookNarrative(b: HandbookBlocks): string {
  return `
# ${BRAND_NAME} — how it works

${b.screens}

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
   and then one of its runs to see that run's log. A run where every
   search query failed (rate limit, quota, provider error) ends
   "failed" and notifies you; one where only some failed ends
   "partial". A run in progress can be cancelled from its page (it stops
   after the query it is on and keeps what it found), and a run that
   makes no progress for 15 minutes is marked failed automatically.
   {H-33} The Crawl engine ([/connectors/engine]) runs recipes on a
   schedule with quiet hours.
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
   Comments teach the system — lessons are extracted automatically, a
   moment after you post, and influence future qualification. @mentions
   (write @user@email) notify teammates. Approving does NOT create a
   pipeline lead, a draft or an email: it records your decision and trains
   the learning memory. {H-01} A decision counts for the products the AI
   found the company relevant to: rejecting, ignoring or archiving an item
   marks it Not a fit for each of them, and from then on Promote, drafting
   and autopilot's generate + enqueue refuse that company for those
   products. {H-36} Review items cannot be assigned to a teammate;
   pipeline leads can, on the lead's page. {H-03} When autopilot's
   auto-approve is on, some approvals are made by autopilot, not by a
   person (see Autopilot).
5. LEADS ([/leads]) lists the relevant matches from discovery, whatever
   their review state (archived ones are hidden). "Promote to pipeline"
   on a lead creates the pipeline lead; it does not need an approval
   first. {H-02} It is not offered for a company marked Not a fit for
   that product (see Review queue).
6. PIPELINE ([/pipeline]): open a lead there to set its contact name and
   CONTACT EMAIL, assign it to a teammate, add notes, set its own
   outreach language and move it through the stages. Nothing fills in
   the contact email for you, and no email can be queued for a lead
   without one. {H-04} ${b.pipelineStages} {H-05} Promoted leads start at relevant. Stages move when you
   move them: sending an email or getting a reply does not advance a
   lead; only a reply auto-action closes a lead, and only while an admin
   has switched it on under [/settings/outreach]; a CRM push sets
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
   page yet (see Known limitations, I002). [/drafts] opens on the drafts
   awaiting approval (draft or needs edit), the same number as the
   Outreach badge's drafts and Today's "Drafts awaiting approval"; "All
   active" adds the approved and rejected ones.
8. SENDING: queued emails go out from a mailbox after a suppression
   check, a geography re-check, the mailbox's sending policy, the domain
   cooldown and the daily limit. The workspace send caps (daily email
   limit, domain cooldown, send delays) live on [/mailbox/queue]: owners
   and admins change them there, everyone else sees a summary. Each
   mailbox's own limits (max per day and per hour, per recipient domain,
   business window, timezone, weekends and holidays) are on that
   mailbox's page, opened from [/mailbox]. {H-06} A held queue entry
   shows its reason on [/mailbox/queue].
   A send that fails for a temporary reason (the mail server busy or
   greylisting, a dropped connection, a translation error) is retried
   automatically, waiting longer each time, up to 5 attempts (3 for an
   error before sending); a refused mailbox login holds the email
   instead, and only a recipient address the server says does not exist
   is suppressed. Failed, skipped and cancelled entries have "Retry now"
   and "Requeue" on [/mailbox/queue] for anyone who can edit; both go
   through suppression, the limits and the domain cooldown again, and
   while automation is paused "Retry now" sends only after you tick
   "send anyway". An
   entry still "sending" after 10 minutes is settled automatically: sent
   if a sent copy exists, otherwise failed as "Interrupted: delivery
   unknown" (check the Sent folder before you retry it; if it is there,
   "Mark as delivered" records it as sent). An email that has already
   gone out is never sent again, from the queue or from the Errors
   folder. {H-34}
9. TRANSLATION: you write in your language. On a draft you can generate
   the translation and review it side by side; the edited translation is
   exactly what is sent. If you don't, the queue translates the approved
   text automatically at send time (when the recipient's language
   differs from yours), and that version is not reviewed by anyone.
   {H-22} Follow-ups work the same way when you approve them.
10. FOLLOW-UPS are configured on [/settings/outreach] (steps, spacing,
   approval). When one is due it is written by AI and either waits for
   approval on [/communication/follow-ups] (also the Follow-ups section
   of [/today]) or, if you switched approval off, is sent without anyone
   reviewing it. {H-15} A reply to your outreach on the thread
   (including an auto-reply or a delivery report about it) cancels the
   remaining follow-ups; newsletters and unrelated mail filed on the
   thread do not. {H-31} Right now follow-ups are NOT scheduled after a
   cold email, so none are sent for cold outreach (see Known
   limitations, I005). {H-14}

## Replies (/communication)
[/communication] shows every thread with its full history. "Suggest
reply (AI)" on a thread drafts a knowledge-grounded reply for you to
edit and send from the thread. Emails you write yourself (from a
thread or a mailbox's compose page) and drafts that answer a
prospect's reply go out as personal mail, without the unsubscribe link
and footer that cold emails and follow-ups carry. {H-26}
Only mail that answers your outreach — a reply to one of your emails,
an auto-reply, or a delivery report about one — gets a class:
${b.replyClasses}. {H-17} Newsletters, notifications
and other unrelated mail are filed on their thread without a class and
trigger nothing (see Known limitations, X1). On a thread
linked to a pipeline lead, and only while "Auto-draft replies" is on,
the next step follows from the class: interest / doc_request → a pitch
draft; question / positive → an engagement draft; redirect → a thank-you
in the thread plus a discovery draft to the person they named (or an
engagement draft asking for their address when none was given);
negative → nothing, unless the reply auto-action "Close the lead on a
negative reply" is on; out_of_office / irrelevant → nothing.
Reply auto-actions are four switches on [/settings/outreach]: suppress
the sender on an unsubscribe reply (also closes the linked lead),
suppress the sender on a bounce (not active yet: nobody is suppressed
or closed from a bounce until bounces can be matched to the email you
sent), close the lead on a negative reply, and create contacts from
redirect replies. The suppress and close switches are off unless an
admin turns them on; only owners and admins can change them, everyone
else sees them read-only. They act only on replies to your outreach.
With a switch off the message is still classified and shown to you,
and you decide what to do. Two things suppress an address whatever the
switches say: the recipient confirming on the page that the
unsubscribe link in your email opens (opening the link alone changes
nothing), and your mail server refusing the address as non-existent
while sending (a refused login suppresses nobody: the mailbox is
marked failing instead). {H-18} Counts per class are on
[/mailbox/deliverability].

## Autopilot (/autopilot)
[/autopilot] is for Starter and Pro plans (and billing-exempt
workspaces): without one its switches cannot be turned on, and a lapsed
plan stops the runs. {H-11} It runs every 5 minutes and right after
every discovery run that found records, but only while its master switch
is on and automation is not paused (see Pausing below). {H-12} Every
step is off until an admin turns it on; a run takes them in this order:
${b.autopilotSteps}
Sending queued mail and reading mailboxes are not autopilot steps: they
always run in the background (see Pausing below).
One thing at a time: only one autopilot run works in a workspace at
once. "Run now" while a run is going (the 5-minute one, or the one after
a crawl) starts nothing and says since when the other has been running;
that run does the same work. Likewise one send pass sends at a time
("Send due emails now" and Retry now while a pass is sending only put
the email back for the next pass, so the daily limit is never
overshot), one sync or connection test runs per mailbox, and one run per
search recipe (a plan or "Run now" skips a recipe whose last run is
still going, and says so).
Per-product overrides (pick a product on [/autopilot]) only narrow what
the workspace runs: autopilot or a step can be switched off for that
product, or its approval threshold raised; switching on what the
workspace has off is refused. "Pause <product>" there (anyone who can
edit; owners and admins resume) stops autopilot for that product and
holds its queued emails and follow-ups — not sent, not failed — until it
is resumed; email you write yourself still sends. {H-13} The Crawl engine
page ([/connectors/engine]) shows the autopilot steps read-only, with a
link to [/autopilot] to change them.

Pausing all automation — one switch for the whole workspace:
- "Pause all automation" (on [/autopilot] and [/mailbox/queue]; anyone
  who can edit, never blocked by the plan or an empty wallet) stops at
  the next item everything that runs on its own: the send queue,
  follow-ups (nothing is composed), autopilot, scheduled crawls, reply
  auto-actions (the suppress and close switches on [/settings/outreach]
  wait for you), background AI (drafting, translation, compaction, learning from your decisions),
  auto top-up and the trash purge.
  Nothing fails or is lost — it waits — and a banner on every page says
  who paused and when. {H-09} Anyone who can edit also reaches it from
  "Emergency stop" at the foot of the sidebar.
- While paused, mailboxes keep syncing so replies still arrive. An email
  you write yourself (a thread reply, compose, approving a follow-up)
  sends only after you tick "send anyway", which is recorded in the
  audit log. Only owners and admins resume; whoever paused can undo it
  within 10 seconds. {H-10}
- A paused, failing or archived mailbox holds its due emails and
  follow-ups — not sent, not failed — until it is active again; each
  queue entry says why. Pause or re-enable a mailbox with the status
  switch on its Edit page, opened from [/mailbox]. {H-23}
- New workspaces are not live for outreach: cold emails, follow-ups and
  AI reply drafts wait in the send queue until the platform releases
  the workspace (a banner says so), while email you write yourself sends
  normally. {H-32}
- Approved emails in the send queue go out every 30 seconds and
  mailboxes sync every 2 minutes, whether or not autopilot is on: only
  the pause, a hold or the go-live hold stops sending. Background
  mailbox sync is switched off under "Mailbox auto-sync" on
  [/settings/outreach].

## Mailboxes (/mailbox)
Add one on [/mailbox/new]: SMTP for sending, IMAP for receiving. You need
an active mailbox to send and receive. A mailbox is active, paused (see
above), archived, or failing. Every mailbox's mail server is checked
every 30 minutes without logging in, and its login once a day. It is
marked failing when its server refuses the login, cannot be reached
twice in a row, or its sync keeps failing, and the workspace's owners
and admins get one "mailbox failing" notification. While it is failing,
its queued emails and follow-ups are HELD — not sent and not failed —
and replies, bounces and unsubscribes sent to it are not read. What
happens next depends on the cause: a refused login is never retried on
its own (repeated failed logins get our server blocked); a server that
cannot be reached is checked without logging in, every 30 minutes at
first and backing off to every 6 hours, and one login is tried once it
answers; an unclear error gets at most four login attempts, six hours
apart. When a check passes it is active again and the owners and admins
are told it is back online. {H-16} To fix it now: the mailbox's page
says what broke and what to change (a server that refuses SMTP port 587
usually wants port 465, TLS on connect); change it on its Edit page —
saving new connection settings runs one check within minutes — or click
Test again on the mailbox's page. Send a test email from the
mailbox's page; signatures live on [/mailbox/signatures]; the
suppression list (addresses that are never emailed, checked before
every send) on [/mailbox/suppression].

## Tokens & billing (/settings/billing)
- Tokens are the prepaid currency for ALL metered work: discovery
  search, AI qualification, drafting, reply suggestions, translation.
  1 token ≈ €0.01. New workspaces start with 500 free tokens.
${b.billing}
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
and indexed for retrieval AUTOMATICALLY, in the background right after
the upload; the reply assistant and pitch composer ground their answers
in these. Ticking products on the upload form scopes the knowledge to
those products (a knowledge source is created and indexed for you, once
however many products you tick); uploads without products are available
workspace-wide. Byte-identical re-uploads are detected and skipped; when
a file changes, upload the new version. Knowledge sources created on
[/knowledge/new] are indexed the same way. Every source shows its index
status — queued, indexing, indexed, stale (changed since it was indexed)
or failed — and its page updates on its own while it is queued or
indexing. Editing a source's text, URL, summary or products marks it
stale and re-indexes it automatically; drafts use the previous version
until that finishes. A failed run is retried a few times, then the
workspace gets one notification for that source. {H-39}
Scanned / image-based PDFs (no text layer) are OCR'd automatically via
Mistral when a Mistral API key is configured (platform-wide by the
admin, or the workspace's own under BYOK) — once per file: the text is
kept, so re-indexing never pays for OCR again. Without a key they fail
with a clear message instead of indexing empty. On a PDF's page, owners
and admins can force a fresh read with "Re-extract with OCR", which
shows the estimated cost first. Deleting a knowledge source needs its
title typed to confirm.
Download on a document's page (opened from [/documents]) sends the
original file through the app to any member of the workspace, viewers
included; an archived document sends you back to its page with a
message instead (restore it first). {H-28} The CSV export on
[/settings/crm] downloads the same way.

## Learning memory (/learning) — the platform teaches itself
Lessons are rules qualification and outreach follow. They come from
four channels: (1) review decisions and comments, learned in the
background a moment after you decide (badge "from a decision") — one
rule per decision, scoped to every product that got the same verdict,
and only when there is something to learn: a written reason, a verdict
that contradicts the AI's, or overturning autopilot. A decision that
simply agrees with the AI makes no new rule; it strengthens the rules
the AI relied on and weakens the ones that pointed the other way. A
suggested rule the AI is less than 50% sure of is dropped. Learning
uses AI tokens: with an empty wallet it waits and resumes after a
top-up. Changing your mind undoes what the earlier decision taught —
rule confidences go back and a rule learned only from it is retired.
If learning fails 5 times you get one notification that day; the
decision itself is always saved. {H-38} (2) the
operator's edits to AI drafts — a material rewrite is diffed and
distilled into a style rule (badge "from your edits"); (3) reply
outcomes — switched off for every workspace for now, so replies teach
nothing (reply classes are still keyword guesses, see I088); {H-37}
(4) a weekly AI synthesis pass that mines people's recent decisions
(never autopilot's, never one that was later changed) for patterns and
proposes new rules (badge "auto-learned", modest starting confidence).
Admins can trigger "Synthesize now" and "Compact now" on [/learning].
Confidence self-adjusts from outcomes; persistently contradicted
lessons retire automatically. Any lesson can be edited or disabled.
Repeating the same feedback does NOT create duplicate rules — a repeat
is detected (semantically, not just word-for-word) and strengthens the
existing rule's confidence instead, with the new event added to its
evidence chain.

## Settings that matter
- [/settings/integrations]: AI provider (BYOK), Web Search backend
  (Gemini grounding recommended), embeddings, research provider.
- [/settings/outreach] (owners and admins; everyone else sees only the
  reply auto-action switches, read-only): workspace native language,
  default outreach language, "Auto-draft replies" (AI drafts the next
  reply on lead threads for your review; a reply draft is never sent
  until you approve it), the reply
  auto-action switches (see Replies), follow-up schedule and approval,
  mailbox auto-sync, trash retention.
- [/settings/members]: owners and admins add teammates and set their
  roles. Only an owner can grant, change or remove the owner role,
  nobody can change their own role, and a workspace always keeps at
  least one owner. {H-27}
- [/settings/crm]: CRM connections, plus a CSV export of every pipeline
  lead.
- [/settings/usage]: usage events and units per kind of work and
  provider over a chosen range; owners and admins also see the tokens
  charged for them (as on [/settings/billing]). [/settings/audit]: who
  changed what (admins). [/settings/account]: your name and password.
- [/health]: the workspace checks, live: what is broken or stopped and
  why — the pause, holds, the platform stop, not live yet, each failing
  mailbox (with how to fix it), no active mailbox or product, recipes
  without a target country, the mock search, a noisy review queue, a
  spike of automatic suppressions, failed or empty runs, open incidents —
  each with the page that fixes it; Today shows the problems on top. A
  free check every 6 hours notifies owners and admins when a new problem
  appears (at most once a day per kind). The scheduled report adds an AI
  review of recent conversations; owners and admins switch it off (it
  then spends no tokens), set its interval or run it now. {H-61}
- The numbers on the sidebar, on Today and on the bell are one set of
  counts: open review items, drafts and follow-ups awaiting approval,
  prospect replies nobody has answered (trash and spam left out), unread
  notifications and the problems [/health] lists. The sidebar's badges
  refresh on their own (every minute while the page is open, and when
  you come back to the tab); Today and the bell refresh when you open a
  page. "—" means a number could not be loaded just now; it is not zero.

## Contacting a human (/support)
When the assistant can't solve it, [/support] (the account menu at the
top right → Help & support) messages the platform team directly — billing disputes, bugs,
feature requests. Replies arrive on the same page and as a
notification. Available to every member, including viewers.
If a page fails you get an error page with Try again and links to
[/today] and [/support]; quote the reference code it shows when
you write to support. A mistyped or removed address shows a "page not
found" page. {H-29}
The platform team cannot sign in as you or act in your name: there is
no impersonation. When a platform admin changes something in your
workspace (tokens, members, a support reply) it is recorded under
their own name on [/settings/audit]; what they do to other users or to
platform settings is never filed in your workspace. {H-30}

## Common problems
- "No leads found": check the recipe has queries, the Web Search
  backend on [/settings/integrations] is real (not mock — see Known
  limitations, I073), and the wallet has tokens.
- "Leads from the wrong country": set the recipe's target country.
  Without one there is no geography check at all; with one, mismatches
  are rejected and unverifiable companies go to review.
- "An address was suppressed or a lead closed by itself": the recipient
  confirmed the unsubscribe page, your mail server refused the address
  as non-existent, or a reply auto-action switch on [/settings/outreach]
  is on and they replied to your outreach (see Replies and Known
  limitations, X1). [/mailbox/suppression] shows each entry's source,
  and an admin can revoke an entry there.
- "Draft won't send" — check in this order: (1) is the draft approved?
  (2) does it have a pipeline lead with a contact email (open the lead
  from [/pipeline])? (3) is it really in the queue on [/mailbox/queue]?
  Hand-approved drafts can't be queued from the draft page yet (Known
  limitations, I002). (4) is automation paused (the banner says who
  paused it; an owner or admin resumes it on [/autopilot]), or is the
  workspace not live for outreach yet (the platform releases it)? For
  autopilot drafts also check the master switch on [/autopilot].
  (5) has the daily email limit
  been reached, or is a domain cooldown or the mailbox's business window
  holding it (the queue entry shows why)? (6) is the mailbox paused or
  failing? (7) is the address on [/mailbox/suppression], or did the
  geography re-check block it?
- "Emails in the wrong language": the first of these that is set wins —
  ${b.languagePrecedence} {H-19}
  Translations can be reviewed on the draft before it is sent.
- "Everything is paused": check (1) the banner at the top of the page —
  automation may be paused (owners and admins resume it on [/autopilot]),
  on hold by the platform, or not live for outreach yet; (2) the token
  wallet on [/settings/billing] — an empty wallet pauses discovery,
  drafting and translation; (3) the autopilot master switch on
  [/autopilot]; (4) each mailbox's status under [/mailbox] — paused or
  failing.
`.trim();
}
