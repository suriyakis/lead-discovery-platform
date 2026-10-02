# Information architecture

Status: decided by the owner (2026-10, the DS-00 decision pack: Direction A
"Sonar Instrument", the target IA below, one product name "Leadsonar").
Encoded by DS-05, which absorbs AP-03 and ia:F-10. The DS-05 acceptance
asks the owner and the five workstream leads (workspace, knowledge,
discovery, outreach, ops) to approve this file in the PR.

The single source is the navigation registry, `src/lib/nav/registry.ts`.
The Sidebar, the area tabs and Settings sub-nav (`AreaNav`), the Cmd-K
palette, the Platform console nav, the mobile tab bar definition, the
legacy redirects and the route table printed by the assistant handbook and
`docs/USER_GUIDE.md` all read it. Change the registry, not this file's
tables, then update this file in the same PR. The full generated route
table (every page, its area, its purpose and who sees it) is at the end of
`docs/USER_GUIDE.md` (`pnpm handbook:export`).

## Principles

1. One home per job: every page belongs to exactly one area; other surfaces
   link to it.
2. Navigation is data: no component keeps its own list of pages.
3. URLs are stable: areas point at today's URLs; a page that moves gets a
   permanent redirect row and its producers are updated in the same PR.
4. One word per concept (vocabulary below); the console is "Platform
   console" everywhere, never "God mode".
5. Counts are honest: a badge only shows a number when it means work for
   a person, and only turns amber when a decision waits on this user.

## Sitemap

Home is **Today** (`/today`). The sidebar shows Today, then three groups
under static headings (not accordions), then the Platform console for
super-admins: 8 items for a workspace user, 9 for a super-admin. My account
and Help & support live in the account menu at the top right. At 800px and
below (an interim width, where the legacy app shell collapses) the same
items form one horizontally scrolling strip above the page; the drawer and
the 5-item tab bar come with visual Phase 2.

| Group | Area | Click target | Tabs (on today's URLs) | Also in the area |
| --- | --- | --- | --- | --- |
| — | Today | `/today` | Needs you `/today` (the approval inbox: Review, Drafts, Replies, Follow-ups via `?tab=`) · Overview `/today?view=overview` (the old dashboard) · Activity `/notifications` | Setup checklist `/onboarding` |
| Work | Review | `/review` | Queue `/review` · By product `/leads` | Record `/review/[id]` |
| Work | Pipeline | `/pipeline` | Leads `/pipeline` · Contacts `/contacts` | Lead, Contact pages |
| Work | Outreach | `/drafts` | Drafts `/drafts` · Follow-ups `/communication/follow-ups` · Send queue `/mailbox/queue` · Deliverability `/mailbox/deliverability` | Draft `/drafts/[id]` |
| Work | Conversations | `/communication` | Threads `/communication` | Thread `/communication/[threadId]`, Compose `/mailbox/[id]/compose` |
| Build | Discovery | `/connectors` | Searches `/connectors` · Schedules `/connectors/engine` | New search source, Search source, New search, Search, Run |
| Build | Products | `/products` | Products · Knowledge · Documents · Lessons (`/learning`) | New product, Draft a product with AI, product, knowledge, document and lesson pages |
| Workspace | Settings | `/settings/members` | Grouped sub-nav, below | New mailbox, Mailbox, Edit / Test mailbox, CRM connection pages |
| Platform | Platform console (super-admins) | `/admin` | Overview · Workspaces · Users · Providers · Support inbox · Platform audit log | Workspace, User, Support thread pages |
| Account menu | Help & support | `/support` | — | Support thread `/support/[id]` |

**Settings sub-nav** (shown on every Settings page, `/settings/*`,
`/mailbox` and its mailbox pages, `/autopilot`, `/health`; a column beside
the page from 1200px, the design system's lg breakpoint, and a strip above
it below that):

| Section | Items |
| --- | --- |
| Workspace | Members · Plan & billing · Usage · Audit log (owners and admins) |
| Mail & sending | Mailboxes (`/mailbox`) · Signatures · Suppression · Replies & follow-ups (`/settings/outreach`) |
| Automation | Autopilot (`/autopilot`) · Health checks (`/health`) |
| Connections | AI & search (`/settings/integrations`) · CRM & export |
| You | My account (`/settings/account`, also in the account menu) |

Deliberate homes for pages under `/mailbox`: the Send queue and
Deliverability are Outreach work, Compose belongs to Conversations, and
`/mailbox/threads/[id]` is a legacy redirect to the thread.

Pages in no area (`UNLISTED_ROUTES`, each with its reason): `/` (landing
and sign-in), `/pending`, the redirect stubs `/dashboard`, `/inbox`,
`/settings` and `/mailbox/threads/[id]`, the test probe
`/test-only/error-boundary`, and the design-system gallery `/dev/gallery`
(both 404 unless `ENABLE_TEST_ROUTES=1`). A new page that is in no area and
not unlisted fails `src/tests/nav-registry.test.ts`.

**Cmd-K** lists, for the viewer's role: each area (named as in the
sidebar), its other tabs, the account-menu pages, the console for
super-admins, and four actions — Emergency stop (interim, below), Add a
teammate, New product, New search source. Old names are search keywords
(inbox, dashboard, crawl engine, connectors, learning memory…). It is
mounted in the workspace app and in the Platform console, with a visible
Search button in both headers.

**Mobile tab bar** (defined, rendered by visual Phase 2): Today · Review ·
Outreach · Conversations · More. Pipeline lives in the drawer.

### Interim entries

- **Emergency stop** (owners and admins): pinned at the foot of the
  sidebar and offered in Cmd-K, it opens the send-queue pause
  (`/mailbox/queue#send-settings`), the only control that stops the drain
  today, and says "Stops queued sending only". The one Pause that stops
  all automation (ia:F-18, automation-control lane) replaces it and
  becomes Cmd-K's "Pause all outbound" action.
- **Today** carries the old inbox and dashboard content until the Today hub
  (ia:F-23) replaces it.

## Vocabulary

| Term | Means | Replaces |
| --- | --- | --- |
| Leadsonar | The product, in prose (`BRAND_NAME`) | Lead Discovery Platform, signal/works |
| lead/sonar | The mono wordmark beside the mark, once per page (the brand header, the console topbar or a backstop; on a phone, a header that also carries controls shows the mark alone). The mark (decision D17) is the market-navigator gradient tile carrying the sonar glyph of the old favicon: one geometry in `src/lib/brand-mark.ts`, drawn inline on the tokens by `components/Brand.tsx`, and rendered into the favicon, the app icons and the link preview by `pnpm brand:icons` (DS-08) | The second sidebar wordmark, the dark-square tile |
| Today | The signed-in home | Dashboard, Inbox |
| Record | A company or page found by discovery (a review item) | "Lead" on Review |
| Verdict / match | The AI judgement of one record for one product | — |
| Lead | A record promoted to the pipeline for a product (Promote on Review › By product; approving a record does not promote it, I031) | Qualified lead |
| Search / search source | A recipe / the connector it runs on | Recipe, connector (kept as Cmd-K keywords) |
| Schedule | When searches run (a crawl plan) | Crawl Engine |
| Lessons | Rules learned from decisions and replies | Learning memory |
| Conversation / thread | A mail thread | Communication |
| Mailbox | A connected account: configuration, in Settings | Mailbox as a place to read mail |
| Platform console | The super-admin area | God mode, Admin, Overview |
| Workspace audit log / Platform audit log | The two logs | Two entries both called "Audit log" |

## Labels and tones

Every value the UI shows has one label and one tone, from one place:
`src/lib/ui/labels.ts` (words, in the vocabulary above) and
`src/lib/ui/tone.ts` (meaning). Both cover every pgEnum and every
text-column registry (reply classes, follow-up statuses, notification,
audit and usage kinds in `src/lib/kinds/`, …), checked by typecheck and by
`src/tests/signals.test.ts`. Pages render values with `<StatusBadge>`
(`src/components/Badge.tsx`), never the raw code. Highlights:

| Value | Label | Tone |
| --- | --- | --- |
| Review state `needs_review` | Needs review | attention (the only amber state) |
| Outreach stage `discovery` … `closing` | First contact, Engagement, Pitch, Closing | neutral: a stage is a kind of message |
| Close reason | Won … Other | success for Won only, otherwise neutral; never red |
| Pipeline progress `relevant` … `synced_to_crm` | Relevant … Synced to CRM (funnel, kanban and filter alike) | info; position and the one-hue ramp carry progress |
| Follow-up `pending` | Scheduled | neutral |
| Reply class | e.g. "Question · auto" | neutral until reply triage is trusted (I088) |
| Usage `ai.assistant` | Assistant questions | neutral |

## Count policy

Counts are data: each badge in the registry has a count key, a tone and an
optional gate (`NavCountSpec`). A count whose gate is unmet renders in the
neutral tone, or not at all. Zero renders no badge; a number that failed
to load renders "—" in the neutral tone, never 0 (MOB-02). Numbers above
99 print as 99+; screen readers get the full phrase.

| Where | Count | Tone | Gate |
| --- | --- | --- | --- |
| Review | records not yet decided (new + needs_review) | attention | only while needs_review > 0; otherwise neutral (prod: 310 untouched "new" records stay neutral) |
| Outreach | drafts + follow-ups awaiting approval | attention | — |
| Conversations | unhandled replies | — | blocked until reply triage is trusted (I084): no number |
| Account menu › Help & support | unread replies from the platform team | neutral | — (also shown on the closed menu) |
| Platform console (sidebar, console nav) | unread support threads | neutral | super-admins only |
| Bell | unread notifications (events) | neutral | — |

No other badges: Pipeline, Discovery, Products and Settings have none.

Every number comes from ONE object, the attention summary
(`getAttentionSummary(ctx)` in `src/lib/attention`, served as
`GET /api/attention`, MOB-02). `src/lib/services/nav-counts.ts` is only its
projection onto the registry's keys; Today's Needs-you tabs and Overview
tiles, the bell and the assistant read the same summary, and the Sidebar
keeps it current in the browser with `useAttention()` (on focus, every
60 s while visible, when the connection returns, after a mutation, on a
service-worker message). Each key has one definition and equals the
default list of the page it opens:

| Key | Counts | Opens |
| --- | --- | --- |
| `review.open` | review items new + needs_review | Today › Review |
| `review.needsReview` | needs_review only (the Review badge's amber gate) | /review?state=needs_review |
| `review.mine` | open review items assigned to the viewer | Today › Review |
| `drafts.approve` | drafts in draft or needs_edit | /drafts (default: Awaiting approval) |
| `followUps.approve` | follow-ups awaiting approval | Today › Follow-ups |
| `replies.awaiting` | threads whose newest prospect reply (trash and spam left out) has no sent answer after it | Today › Replies |
| `replies.overdue` | the same, waiting more than 24 hours | Today › Replies |
| `notifications.unread` | the viewer's unread notifications | the bell |
| `support.unread` | support threads with an unread platform reply | Help & support |
| `problems` | critical + warning findings of the diagnostics engine | /health |

A later deliverable that changes a key's meaning changes its destination
page in the same PR (MOB-14 review.decide, MOB-16 follow-ups into drafts,
MOB-17 the handled state behind replies).

## Redirects

The retired pages stay as permanent (308) redirect stubs, so bookmarks,
stored notification links and old e-mails keep working; the query string
is kept (`src/lib/nav/redirects.ts`, pinned by
`src/tests/nav-registry.test.ts` and `nav-shell.test.ts`).

| Old URL | New home |
| --- | --- |
| `/dashboard` (any query) | `/today?view=overview` (+ the query) |
| `/inbox?tab=X` | `/today?tab=X` |
| `/settings` | the first Settings page in the registry (`/settings/members`) |
| `/mailbox/threads/[id]` | `/communication/[id]` (unchanged, earlier phase) |

Every href producer moved with them: sign-in and the team login, the
pending wall, onboarding, the no-workspace redirects of server actions and
downloads, the console guard, the error and 404 pages, and every page's
breadcrumb root ("Today"). Console breadcrumbs start at "Platform console".

## Planned moves (later waves)

From the IA proposal's sitemap; each lands with its deliverable, a
redirect row here and a registry change: Today hub (`ia:F-23`), Activity
into Today (`F-36`), `/leads` into Review › By product (`F-31`), Outreach
under `/outreach/*` (`F-34`), Conversations under `/conversations`
(`F-35`), mailboxes and sending under `/settings/*` (`F-19`, `F-15`),
Autopilot and Health under `/settings/automation` and `/settings/health`
(`F-20`, `F-16`), My account to `/account` (`F-19`), the Products hub
(`F-32`) and Discovery's searches page (`F-33`).
