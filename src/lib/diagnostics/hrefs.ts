// AP-06: fix links come from the navigation registry (DS-05), so a moved
// page moves every finding's link with it. Detail pages (/mailbox/<id>,
// /knowledge/<id>) are built from their registered list page.
//
// Resolved lazily: tabById() throws for an unknown id, and a typo here
// must fail the rule that uses it (diagnostics.partial), not the import.

import { NAV_ACTIONS } from '@/lib/nav/registry';
import { tabById } from '@/lib/nav/resolve';

function tab(id: string): string {
  return tabById(id).tab.href;
}

function action(id: string): string {
  const found = NAV_ACTIONS.find((a) => a.id === id);
  if (!found) throw new Error(`nav registry: no action "${id}"`);
  return found.href;
}

export const fixHref = {
  billing: () => tab('settings.billing'),
  newProduct: () => action('action.newProduct'),
  mailboxes: () => tab('settings.mailboxes'),
  mailbox: (id: bigint | string) => `${tab('settings.mailboxes')}/${id}`,
  newMailbox: () => `${tab('settings.mailboxes')}/new`,
  suppression: () => tab('settings.suppression'),
  sendQueue: () => tab('outreach.queue'),
  searches: () => tab('discovery.searches'),
  schedules: () => tab('discovery.schedules'),
  integrations: () => tab('settings.integrations'),
  review: () => tab('review.queue'),
  drafts: () => tab('outreach.drafts'),
  draft: (id: bigint | string) => `${tab('outreach.drafts')}/${id}`,
  followUps: () => tab('outreach.followUps'),
  knowledge: () => tab('products.knowledge'),
  knowledgeSource: (id: bigint | string) => `${tab('products.knowledge')}/${id}`,
  lessons: () => tab('products.lessons'),
  autopilot: () => tab('settings.autopilot'),
  /** The one workspace pause control (PC-05), on the Autopilot page — the
   *  same anchor the hold banner links to. */
  pause: () => `${tab('settings.autopilot')}#pause`,
  members: () => tab('settings.members'),
  health: () => tab('settings.health'),
  support: () => tab('support.threads'),
} as const;
