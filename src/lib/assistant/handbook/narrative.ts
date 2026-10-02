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
  auto_sync_inbound: '',
  auto_approve_projects: `review items still in "new" whose relevance
  score reaches the threshold (default 70) are approved and recorded as
  approved by the workspace owner (or by whoever started the run that
  triggered it), although no person looked at them. needs_review
  (geo-unverified) items are never auto-approved. {H-07}`,
  auto_enqueue_outreach: `for approved items, writes a draft, approves it
  in the workspace owner's name and puts it in the send queue; nobody
  reviews those emails. It still needs a pipeline lead with a contact
  email (see Known limitations, I001). {H-08}`,
  auto_drain_queue: '',
  auto_crm_contact_sync: '',
  auto_crm_deal_on_qualified: '',
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
   page yet (see Known limitations, I002).
8. SENDING: queued emails go out from a mailbox after a suppression
   check, a geography re-check, the mailbox's sending policy, the domain
   cooldown and the daily limit. The workspace send caps (daily email
   limit, domain cooldown, send delays) live on [/mailbox/queue]: owners
   and admins change them there, everyone else sees a summary. Each
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
is on and its emergency pause is off. {H-12} Every step is off until an
admin turns it on; a run takes them in this order:
${b.autopilotSteps}
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
- Send-queue "Emergency pause" (owners and admins, on [/mailbox/queue])
  stops the send queue only. Autopilot keeps writing, approving and
  queueing drafts. {H-10} Owners and admins reach it from "Emergency
  stop" at the foot of the sidebar.
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
above), archived, or failing. It is marked failing when its mail server
refuses the login or its sync keeps failing, and the workspace's owners
and admins get one "mailbox failing" notification. While it is failing,
its queued emails and follow-ups are HELD — not sent and not failed —
and replies, bounces and unsubscribes sent to it are not read. While
"Mailbox auto-sync" is on, background sync re-checks it after a delay
that grows from an hour (six after a refused login) to at most a day,
and makes it active again once the connection works. {H-16} To fix it
now: the mailbox's page says what broke and what to change (a server
that refuses SMTP port 587 usually wants port 465, TLS on connect);
change it on its Edit page, then click Test again on the mailbox's
page. Send a test email from the
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
Download on a document's page (opened from [/documents]) sends the
original file through the app to any member of the workspace, viewers
included; an archived document sends you back to its page with a
message instead (restore it first). {H-28} The CSV export on
[/settings/crm] downloads the same way.

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
- [/settings/outreach] (owners and admins; everyone else sees only the
  reply auto-action switches, read-only): workspace native language,
  default outreach language, "Auto-draft replies" (AI drafts the next
  reply on lead threads for your review; "Auto-send replies" has no
  effect yet, so reply drafts always wait for you), the reply
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
- [/health]: the weekly health report — empty wallet, missing product,
  no mailbox, each failing mailbox (with how to fix it), no active
  mailbox, recipes without a target country, failed runs, review
  backlog, stale drafts, follow-ups awaiting approval, plus an AI review
  of recent conversations. Admins can run it now.

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
  limitations, I002). (4) is the send-queue Emergency pause on
  ([/mailbox/queue]; an owner or admin switches it off)? For autopilot
  drafts also check the master switch and the Emergency pause on
  [/autopilot]. (5) has the daily email limit
  been reached, or is a domain cooldown or the mailbox's business window
  holding it (the queue entry shows why)? (6) is the mailbox paused or
  failing? (7) is the address on [/mailbox/suppression], or did the
  geography re-check block it?
- "Emails in the wrong language": the first of these that is set wins —
  ${b.languagePrecedence} {H-19}
  Translations can be reviewed on the draft before it is sent.
- "Everything is paused": check (1) the token wallet on
  [/settings/billing] — an empty wallet pauses discovery, drafting and
  translation; (2) the master switch and the Emergency pause on
  [/autopilot]; (3) the send-queue Emergency pause on [/mailbox/queue];
  (4) each mailbox's status under [/mailbox] — paused or failing.
`.trim();
}
