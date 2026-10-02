// /knowledge/new and /knowledge/[id] pre-select products through the
// select's defaultValue (deliverable ia:F-08, audit X5). They used to set
// `selected` on each <option>, which React warns about on every load and
// ignores on update. jsx-html-guards.test.ts keeps `selected` out of the
// codebase; this checks the pages still pre-select the right products.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { db } from '@/lib/db/client';
import { makeWorkspaceContext } from '@/lib/services/context';
import { createProductProfile } from '@/lib/services/product-profile';
import { createKnowledgeSource } from '@/lib/services/knowledge-sources';
import NewKnowledgeSourcePage from '@/app/knowledge/new/page';
import KnowledgeSourceDetail from '@/app/knowledge/[id]/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { renderToHtml } from './helpers/next-render';

const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

/** The <option> tag for a product in the "productProfileIds" select. */
function productOption(html: string, id: bigint): string {
  const select = /<select[^>]*name="productProfileIds"[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';
  return new RegExp(`<option[^>]*value="${id}"[^>]*>`).exec(select)?.[0] ?? '';
}

async function setup() {
  const owner = await seedUser({ email: 'owner@test.local' });
  const workspaceId = await seedWorkspace({ name: 'A', ownerUserId: owner });
  const ctx = makeWorkspaceContext({ workspaceId, userId: owner, role: 'owner' });
  const alpha = await createProductProfile(ctx, { name: 'Alpha' });
  const beta = await createProductProfile(ctx, { name: 'Beta' });
  session.current = { user: { id: owner, role: 'member', accountStatus: 'active' } };
  return { ctx, alpha, beta };
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('knowledge product select', () => {
  it('/knowledge/new pre-selects the product from ?product=', async () => {
    const { alpha, beta } = await setup();

    const tree = await NewKnowledgeSourcePage({
      searchParams: Promise.resolve({ product: beta.id.toString() }),
    });
    const html = await renderToHtml(tree);

    expect(productOption(html, beta.id)).toContain('selected=""');
    expect(productOption(html, alpha.id)).not.toContain('selected');
  });

  it('/knowledge/[id] pre-selects the attached products', async () => {
    const { ctx, alpha, beta } = await setup();
    const source = await createKnowledgeSource(ctx, {
      kind: 'text',
      title: 'Spec sheet',
      textExcerpt: 'Thermal conductivity 0.021 W/mK.',
      productProfileIds: [alpha.id],
    });

    const tree = await KnowledgeSourceDetail({
      params: Promise.resolve({ id: source.id.toString() }),
      searchParams: Promise.resolve({}),
    });
    const html = await renderToHtml(tree);

    expect(productOption(html, alpha.id)).toContain('selected=""');
    expect(productOption(html, beta.id)).not.toContain('selected');
  });
});
