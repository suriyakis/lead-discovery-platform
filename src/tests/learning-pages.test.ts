// KL-01: /learning/new and /learning/[id] turn LearningServiceError codes —
// including the composite-FK violation for another tenant's product — into
// sentences, never a raw code or a 500; the new-rule form has no default
// category (I038); the list shows rules that lost every product.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { db } from '@/lib/db/client';
import { productProfiles } from '@/lib/db/schema/products';
import { eq } from 'drizzle-orm';
import { makeWorkspaceContext, type WorkspaceContext } from '@/lib/services/context';
import { createLesson, getLesson, learningErrorMessage } from '@/lib/services/learning';
import { createProductProfile } from '@/lib/services/product-profile';
import NewLessonPage from '@/app/(app)/learning/new/page';
import EditLessonPage from '@/app/(app)/learning/[id]/page';
import LearningPage from '@/app/(app)/learning/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { expectRedirect, renderToHtml } from './helpers/next-render';

const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

async function setup(): Promise<{ a: WorkspaceContext; b: WorkspaceContext }> {
  const ownerA = await seedUser({ email: 'pages-a@test.local' });
  const ownerB = await seedUser({ email: 'pages-b@test.local' });
  const wsA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const wsB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  session.current = { user: { id: ownerA, role: 'member', accountStatus: 'active' } };
  return {
    a: makeWorkspaceContext({ workspaceId: wsA, userId: ownerA, role: 'owner' }),
    b: makeWorkspaceContext({ workspaceId: wsB, userId: ownerB, role: 'owner' }),
  };
}

/** Every <form action={fn}> in a server-component tree, in document order. */
function formActions(node: ReactNode): Array<(fd: FormData) => Promise<void>> {
  const out: Array<(fd: FormData) => Promise<void>> = [];
  const visit = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ action?: unknown; children?: ReactNode }>;
    if (el.type === 'form' && typeof el.props.action === 'function') {
      out.push(el.props.action as (fd: FormData) => Promise<void>);
    }
    visit(el.props.children);
  };
  visit(node);
  return out;
}

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const item of Array.isArray(v) ? v : [v]) fd.append(k, item);
  }
  return fd;
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('learningErrorMessage', () => {
  it('maps every code to a sentence, and unknown codes to a generic one', () => {
    for (const code of [
      'permission_denied',
      'not_found',
      'invalid_input',
      'invariant_violation',
      'unknown_category',
      'invalid_polarity',
      'rule_required',
      'rule_too_long',
      'product_not_found',
      'scope_required',
      'lifecycle_conflict',
      'something_new',
    ]) {
      const msg = learningErrorMessage(code)!;
      expect(msg.length).toBeGreaterThan(20);
      expect(msg).not.toContain('_');
    }
    expect(learningErrorMessage(undefined)).toBeNull();
  });
});

describe('/learning/new', () => {
  it('has no default category: a placeholder is selected, no real category is', async () => {
    await setup();
    const html = await renderToHtml(await NewLessonPage({ searchParams: Promise.resolve({}) }));
    const select = /<select[^>]*name="category"[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';
    const selected = (select.match(/<option[^>]*>/g) ?? []).filter((o) => /selected=""/.test(o));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('value=""');
    expect(select).toContain('value="general_instruction"');
    expect(select).not.toContain('value="dedupe_hint"');
    expect(select).not.toContain('value="false_positive"');
  });

  it("another tenant's product → redirect with the code → the page shows 'Product not found', not the code", async () => {
    const { b } = await setup();
    const productB = await createProductProfile(b, { name: 'B product' });
    const tree = await NewLessonPage({ searchParams: Promise.resolve({}) });
    const [create] = formActions(tree);
    const target = await expectRedirect(() =>
      create!(
        form({
          rule: 'Skip councils',
          category: 'qualification_negative',
          scope: 'products',
          productProfileIds: [productB.id.toString()],
        }),
      ),
    );
    expect(target).toBe('/learning/new?error=product_not_found');

    const html = await renderToHtml(
      await NewLessonPage({ searchParams: Promise.resolve({ error: 'product_not_found' }) }),
    );
    expect(html).toContain('Product not found');
    expect(html).not.toContain('product_not_found');
  });

  it('missing category or empty product choice come back as sentences', async () => {
    await setup();
    const tree = await NewLessonPage({ searchParams: Promise.resolve({}) });
    const [create] = formActions(tree);
    expect(await expectRedirect(() => create!(form({ rule: 'Skip councils', category: '' })))).toBe(
      '/learning/new?error=unknown_category',
    );
    expect(
      await expectRedirect(() =>
        create!(
          form({ rule: 'Skip councils', category: 'qualification_negative', scope: 'products' }),
        ),
      ),
    ).toBe('/learning/new?error=scope_required');
    const html = await renderToHtml(
      await NewLessonPage({ searchParams: Promise.resolve({ error: 'scope_required' }) }),
    );
    expect(html).toContain('Choose at least one product');
  });

  it('creates a product-scoped rule with the chosen direction', async () => {
    const { a } = await setup();
    const p = await createProductProfile(a, { name: 'Vetrofluid' });
    const tree = await NewLessonPage({ searchParams: Promise.resolve({}) });
    const [create] = formActions(tree);
    const target = await expectRedirect(() =>
      create!(
        form({
          rule: 'Councils never buy directly',
          category: 'sector_preference',
          polarity: 'avoid',
          scope: 'products',
          productProfileIds: [p.id.toString()],
          confidence: '70',
        }),
      ),
    );
    const id = BigInt(/^\/learning\/(\d+)$/.exec(target)![1]!);
    const lesson = await getLesson(a, id);
    expect([lesson.category, lesson.polarity, lesson.scopeKind, lesson.confidence]).toEqual([
      'sector_preference',
      -1,
      'products',
      70,
    ]);
  });
});

describe('/learning/[id]', () => {
  it("re-scoping to another tenant's product shows 'Product not found'", async () => {
    const { a, b } = await setup();
    const productB = await createProductProfile(b, { name: 'B product' });
    const lesson = await createLesson(a, {
      category: 'qualification_negative',
      rule: 'Skip councils',
    });
    const params = Promise.resolve({ id: lesson.id.toString() });
    const tree = await EditLessonPage({ params, searchParams: Promise.resolve({}) });
    const [update] = formActions(tree);
    const target = await expectRedirect(() =>
      update!(
        form({
          rule: 'Skip councils',
          category: 'qualification_negative',
          polarity: 'avoid',
          scope: 'products',
          productProfileIds: [productB.id.toString()],
          confidence: '65',
        }),
      ),
    );
    expect(target).toBe(`/learning/${lesson.id}?error=product_not_found`);
    const html = await renderToHtml(
      await EditLessonPage({
        params: Promise.resolve({ id: lesson.id.toString() }),
        searchParams: Promise.resolve({ error: 'product_not_found' }),
      }),
    );
    expect(html).toContain('Product not found');
    expect(html).not.toContain('product_not_found');
    expect((await getLesson(a, lesson.id)).scopeKind).toBe('workspace');
  });

  it('a rule whose product was deleted says so and refuses Enable with a sentence', async () => {
    const { a } = await setup();
    const p = await createProductProfile(a, { name: 'Doomed' });
    const lesson = await createLesson(a, {
      category: 'qualification_negative',
      rule: 'Skip councils',
      scope: { kind: 'products', productProfileIds: [p.id] },
    });
    await db.delete(productProfiles).where(eq(productProfiles.id, p.id));
    const params = () => Promise.resolve({ id: lesson.id.toString() });
    const tree = await EditLessonPage({ params: params(), searchParams: Promise.resolve({}) });
    const html = await renderToHtml(tree);
    expect(html).toContain('Needs a scope');

    // Status forms come after the edit form: [update, disable].
    const actions = formActions(tree);
    await expectRedirect(() => actions[1]!(form({ intent: 'disable' })));
    const tree2 = await EditLessonPage({ params: params(), searchParams: Promise.resolve({}) });
    const [, enable] = formActions(tree2);
    expect(await expectRedirect(() => enable!(form({ intent: 'enable' })))).toBe(
      `/learning/${lesson.id}?error=scope_required`,
    );
  });
});

describe('/learning list', () => {
  it('flags rules that lost every product and labels categories from the registry', async () => {
    const { a } = await setup();
    const p = await createProductProfile(a, { name: 'Doomed' });
    await createLesson(a, {
      category: 'qualification_negative',
      rule: 'Orphaned rule',
      scope: { kind: 'products', productProfileIds: [p.id] },
    });
    await createLesson(a, { category: 'sector_preference', rule: 'Avoid councils' });
    await db.delete(productProfiles).where(eq(productProfiles.id, p.id));

    const html = await renderToHtml(await LearningPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('Needs a scope');
    expect(html).toContain('lost every');
    expect(html).toContain('Sector preference');
    expect(html).toContain('Avoid');
    expect(html).not.toContain('dedupe hint');
  });
});
