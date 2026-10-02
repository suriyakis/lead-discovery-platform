// DS-08: the brand kit — one name, one mark, Lucide icons in the chrome,
// and the installable shell (favicon, manifest, touch icons, link preview).
//
// - The retired working title appears nowhere in src/ (I139).
// - BRAND_COLOURS are the tokens' own sRGB values, so the files that cannot
//   read CSS (icons, manifest, theme-color) match the app.
// - The inline mark and every generated file draw ONE geometry
//   (src/lib/brand-mark.ts); the committed files are what `pnpm
//   brand:icons` renders from it (scripts/brand-icons.lock.json), at the
//   sizes the manifest and Next's file conventions declare (I176).
// - The mark is an image with a name; each brand chrome renders one
//   wordmark; the chrome draws no emoji.
// What Next actually serves (/manifest.webmanifest, the icon URLs, the
// <link>/<meta> tags) is e2e/brand.spec.ts.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/google', () => ({
  Inter: () => ({ variable: 'font-inter', className: 'font-inter' }),
  JetBrains_Mono: () => ({ variable: 'font-jetbrains', className: 'font-jetbrains' }),
}));
// WorkspaceSwitcher's server action reaches Auth.js; nothing here signs in.
vi.mock('@/lib/auth', () => ({ auth: async () => null }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/admin/workspaces',
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, prefetch() {}, back() {} }),
}));

import {
  BRAND_COLOUR_TOKENS,
  BRAND_COLOURS,
  BRAND_DESCRIPTION,
  BRAND_NAME,
  BRAND_WORDMARK_TEXT,
  type BrandColour,
} from '@/lib/brand';
import {
  arcPath,
  BRAND_ICON_FILES,
  BRAND_ICON_LOCK_FILE,
  type BrandIconLock,
  glyphBounds,
  MARK_ARCS,
  MARK_ECHO,
  MARK_GRID,
  MARK_ORIGIN,
  markSvg,
  MASKABLE_SAFE_RADIUS,
  maskableTransform,
  OG_IMAGE_ALT,
  OG_IMAGE_ALT_FILE,
  SWEEP_PATH,
} from '@/lib/brand-mark';
import { appOrigin, DEFAULT_APP_ORIGIN } from '@/lib/app-origin';
import { HOME_PATH } from '@/lib/nav/registry';
import { BrandLockup, BrandMark } from '@/components/Brand';
import { BrandHeader } from '@/components/BrandHeader';
import { AdminShell } from '@/components/AdminShell';
import { RoleIcon, ROLE_ICONS } from '@/components/RoleIcon';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { workspaceMemberRole } from '@/lib/db/schema/workspaces';
import manifest from '@/app/manifest';
import { metadata, viewport } from '@/app/layout';
import { resolveColor } from './helpers/color';
import { loadCssFile, rootTokens } from './helpers/css-cascade';

const ROOT = process.cwd();
const repoPath = (p: string) => path.join(ROOT, p);
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(repoPath(dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(repoPath(rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
  expect(buf.toString('latin1', 12, 16)).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** The PNG frames of a PNG-in-ICO file, with their directory sizes. */
function icoFrames(buf: Buffer) {
  expect(buf.readUInt16LE(0)).toBe(0);
  expect(buf.readUInt16LE(2)).toBe(1);
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const e = 6 + 16 * i;
    const size = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    const png = buf.subarray(offset, offset + size);
    return {
      dirWidth: buf.readUInt8(e) || 256,
      dirHeight: buf.readUInt8(e + 1) || 256,
      ...pngSize(png),
    };
  });
}

const toHex = (x: number) =>
  Math.round(Math.min(1, Math.max(0, x)) * 255)
    .toString(16)
    .padStart(2, '0');

describe('one name (I139)', () => {
  // Built from parts so this file does not match itself.
  const RETIRED = new RegExp(['Lead', 'Discovery', 'Platform'].join('\\s+'), 'i');

  it('the retired working title appears nowhere in src/', () => {
    expect(RETIRED.test(['Lead', 'Discovery', 'Platform'].join(' '))).toBe(true);
    const hits = walk('src')
      .filter((f) => /\.(ts|tsx|css|md|json|txt|svg)$/.test(f))
      .filter((f) => RETIRED.test(readFileSync(repoPath(f), 'utf8')));
    expect(hits).toEqual([]);
  });

  it('the name, the wordmark and the description are the constants', () => {
    expect(BRAND_NAME).toBe('Leadsonar');
    expect(BRAND_WORDMARK_TEXT).toBe('lead/sonar');
    expect(BRAND_DESCRIPTION.startsWith('Ping the market')).toBe(true);
    // The places I139 found the old title now read the constant.
    for (const f of [
      'src/app/mailbox/[id]/test/page.tsx',
      'src/app/api/signatures/send-test/route.ts',
      'src/lib/services/assistant.ts',
      'src/lib/assistant/handbook/narrative.ts',
    ]) {
      expect(readFileSync(repoPath(f), 'utf8'), f).toContain('${BRAND_NAME}');
    }
  });
});

describe('brand colours are the tokens', () => {
  const tokens = rootTokens(loadCssFile('src/styles/tokens.css'));

  it.each(Object.keys(BRAND_COLOURS) as BrandColour[])('%s', (name) => {
    const c = resolveColor(`var(${BRAND_COLOUR_TOKENS[name]})`, tokens);
    expect(c.a).toBe(1);
    expect(BRAND_COLOURS[name]).toBe(`#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`);
  });

  it('the inline mark reads the tokens themselves', () => {
    const rules = loadCssFile('src/components/Brand.module.css');
    const decl = (sel: string, prop: string) =>
      rules.find((r) => r.selectors.includes(sel))?.decls.find((d) => d.prop === prop)?.value;
    expect(decl('.mark', 'background')).toBe('var(--gradient-mark)');
    expect(decl('.mark', 'color')).toBe('var(--bg)');
    expect(decl('.echo', 'fill')).toBe('var(--amber)');
    // A 'from-sm' wordmark is hidden on phones and joins the mark from 640px up.
    const fromSm = rules.filter((r) => r.selectors.includes('.fromSm'));
    expect(
      fromSm.map((r) => [r.conditions, r.decls.find((d) => d.prop === 'display')?.value]),
    ).toEqual([
      [[], 'none'],
      [['@media (min-width: 640px)'], 'inline'],
    ]);
    expect(decl('.wordmark', 'display')).toBeUndefined();
    expect(tokens.get('--gradient-mark')).toBe(
      'linear-gradient(135deg, var(--primary), var(--teal))',
    );
  });
});

describe('one mark', () => {
  const inline = () => load(renderToStaticMarkup(createElement(BrandMark)), { xml: false });

  it('is an image with a title, and no inline colours', () => {
    const $ = inline();
    const svg = $('svg');
    expect(svg).toHaveLength(1);
    expect(svg.attr('role')).toBe('img');
    const titleId = svg.attr('aria-labelledby');
    expect(titleId).toBeTruthy();
    expect($('svg > title').attr('id')).toBe(titleId);
    expect($('svg > title').text()).toBe(BRAND_NAME);
    expect($('[style]')).toHaveLength(0);
    expect($.html()).not.toMatch(/#[0-9a-f]{3,8}\b|oklch\(|rgb\(/i);
  });

  it('two marks on one page get distinct title ids', () => {
    const $ = load(
      renderToStaticMarkup(
        createElement('div', null, createElement(BrandMark), createElement(BrandMark)),
      ),
    );
    const ids = $('svg title')
      .toArray()
      .map((t) => $(t).attr('id'));
    expect(new Set(ids).size).toBe(2);
  });

  it('draws the same geometry as the favicon file', () => {
    const shapes = (html: string) => {
      const $ = load(html, { xml: true });
      return {
        paths: $('path')
          .toArray()
          .map((p) => $(p).attr('d')),
        circles: $('circle')
          .toArray()
          .map((c) => ['cx', 'cy', 'r'].map((a) => Number($(c).attr(a)))),
      };
    };
    const fromComponent = shapes(renderToStaticMarkup(createElement(BrandMark)));
    const fromFile = shapes(readFileSync(repoPath('src/app/icon.svg'), 'utf8'));
    expect(fromComponent).toEqual(fromFile);
    expect(fromFile.paths).toEqual([...MARK_ARCS.map((a) => arcPath(a.r)), SWEEP_PATH]);
    expect(fromFile.circles).toEqual([
      [MARK_ECHO.x, MARK_ECHO.y, MARK_ECHO.r],
      [MARK_ORIGIN.x, MARK_ORIGIN.y, MARK_ORIGIN.r],
    ]);
  });

  it('icon.svg is the generated tile: the gradient tile on the brand colours, no CSS variables', () => {
    const svg = readFileSync(repoPath('src/app/icon.svg'), 'utf8');
    expect(svg).toBe(markSvg('tile'));
    expect(svg).not.toContain('var(');
    expect(svg).toContain(`stop-color="${BRAND_COLOURS.primary}"`);
    expect(svg).toContain(`stop-color="${BRAND_COLOURS.teal}"`);
    expect(svg).toContain(`fill="${BRAND_COLOURS.amber}"`);
    expect(svg).toContain(`stroke="${BRAND_COLOURS.bg}"`);
  });

  it('the glyph sits inside the tile', () => {
    const b = glyphBounds();
    expect(b.minX).toBeGreaterThan(0);
    expect(b.minY).toBeGreaterThan(0);
    expect(b.maxX).toBeLessThan(MARK_GRID);
    expect(b.maxY).toBeLessThan(MARK_GRID);
  });

  it('the maskable glyph stays inside the safe zone (a circle of 40% around the centre)', () => {
    const b = glyphBounds();
    const t = maskableTransform();
    const c = MARK_GRID / 2;
    for (const [x, y] of [
      [b.minX, b.minY],
      [b.maxX, b.minY],
      [b.minX, b.maxY],
      [b.maxX, b.maxY],
    ] as const) {
      const d = Math.hypot(t.tx + t.scale * x - c, t.ty + t.scale * y - c);
      expect(d).toBeLessThanOrEqual(MASKABLE_SAFE_RADIUS);
    }
    expect(markSvg('maskable')).toContain(`scale(${t.scale})`);
    // Full bleed: no rounded corners for the platform to double up.
    expect(markSvg('maskable')).not.toContain(' rx=');
    expect(markSvg('square')).not.toContain(' rx=');
  });
});

describe('the generated files are current', () => {
  const lock = JSON.parse(readFileSync(repoPath(BRAND_ICON_LOCK_FILE), 'utf8')) as BrandIconLock;

  it('the lock covers exactly the brand files', () => {
    expect(Object.keys(lock.files).sort()).toEqual(BRAND_ICON_FILES.map((f) => f.file).sort());
  });

  it.each(BRAND_ICON_FILES.map((f) => [f.file, f] as const))('%s', (file, spec) => {
    expect(existsSync(repoPath(file)), `${file} is missing: run pnpm brand:icons`).toBe(true);
    const bytes = readFileSync(repoPath(file));
    expect(
      sha256(spec.source),
      `${file} was rendered from an older mark or palette: run pnpm brand:icons`,
    ).toBe(lock.files[file]!.source);
    expect(sha256(bytes), `${file} was changed by hand: run pnpm brand:icons`).toBe(
      lock.files[file]!.output,
    );
    if (spec.kind === 'png') expect(pngSize(bytes)).toEqual(spec.sizes[0]);
    if (spec.kind === 'ico') {
      expect(icoFrames(bytes)).toEqual(
        spec.sizes.map((s) => ({ dirWidth: s.width, dirHeight: s.height, ...s })),
      );
    }
    if (spec.kind === 'svg') expect(bytes.toString('utf8')).toBe(spec.source);
  });

  it('the link preview has its alt text', () => {
    expect(readFileSync(repoPath(OG_IMAGE_ALT_FILE), 'utf8')).toBe(OG_IMAGE_ALT);
    expect(OG_IMAGE_ALT).toContain(BRAND_NAME);
  });

  it("Next's file conventions find them: icon, favicon, apple-icon, opengraph-image, manifest", () => {
    for (const f of [
      'src/app/icon.svg',
      'src/app/favicon.ico',
      'src/app/apple-icon.png',
      'src/app/opengraph-image.png',
      'src/app/opengraph-image.alt.txt',
      'src/app/manifest.ts',
    ]) {
      expect(existsSync(repoPath(f)), f).toBe(true);
    }
    expect(pngSize(readFileSync(repoPath('src/app/apple-icon.png')))).toEqual({
      width: 180,
      height: 180,
    });
  });
});

describe('the installable shell (I176)', () => {
  const m = manifest();

  it('the manifest names Leadsonar, opens standalone on Today, on the page colour', () => {
    expect(m.name).toBe(BRAND_NAME);
    expect(m.short_name).toBe(BRAND_NAME);
    expect(m.description).toBe(BRAND_DESCRIPTION);
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe(HOME_PATH);
    expect(m.start_url).toBe('/today');
    expect(m.scope).toBe('/');
    expect(m.id).toBe('/');
    expect(m.theme_color).toBe(BRAND_COLOURS.bg);
    expect(m.background_color).toBe(BRAND_COLOURS.bg);
  });

  it('lists 192 and 512 icons for any and maskable, each a real file of that size', () => {
    const icons = m.icons ?? [];
    const keys = icons.map((i) => `${i.purpose}:${i.sizes}`).sort();
    expect(keys).toEqual(['any:192x192', 'any:512x512', 'maskable:192x192', 'maskable:512x512']);
    for (const icon of icons) {
      expect(icon.type).toBe('image/png');
      expect(icon.src.startsWith('/')).toBe(true);
      const file = repoPath(path.join('public', icon.src));
      expect(existsSync(file), icon.src).toBe(true);
      const { width, height } = pngSize(readFileSync(file));
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });

  it('the root layout sets the theme colour, the apple web-app title and an absolute og:image base', () => {
    expect(viewport.themeColor).toBe(BRAND_COLOURS.bg);
    expect(viewport.colorScheme).toBe('dark');
    expect(metadata.title).toBe(BRAND_NAME);
    expect(metadata.applicationName).toBe(BRAND_NAME);
    expect(metadata.description).toBe(BRAND_DESCRIPTION);
    expect(metadata.appleWebApp).toMatchObject({ capable: true, title: BRAND_NAME });
    expect(metadata.openGraph).toMatchObject({ siteName: BRAND_NAME, type: 'website' });
    expect(metadata.twitter).toMatchObject({ card: 'summary_large_image' });
    expect(metadata.metadataBase).toBeInstanceOf(URL);
  });

  it('appOrigin: APP_URL, then AUTH_URL / NEXTAUTH_URL, else localhost; origin only', () => {
    expect(appOrigin({ APP_URL: 'https://discover.example.com/some/path?x=1' }).href).toBe(
      'https://discover.example.com/',
    );
    expect(appOrigin({ APP_URL: 'not a url', AUTH_URL: 'https://auth.example.com' }).href).toBe(
      'https://auth.example.com/',
    );
    expect(
      appOrigin({ APP_URL: 'ftp://files.example.com', NEXTAUTH_URL: 'http://x.test:3200' }).href,
    ).toBe('http://x.test:3200/');
    expect(appOrigin({ APP_URL: '  ' }).href).toBe(`${DEFAULT_APP_ORIGIN}/`);
    expect(appOrigin({}).href).toBe(`${DEFAULT_APP_ORIGIN}/`);
  });
});

describe('one wordmark per chrome', () => {
  it('BrandHeader: one mark and one wordmark, inside one home link named Leadsonar', () => {
    const $ = load(renderToStaticMarkup(createElement(BrandHeader)));
    expect($('[data-brand-wordmark]')).toHaveLength(1);
    expect($('[data-brand-wordmark]').text()).toBe(BRAND_WORDMARK_TEXT);
    expect($('svg[data-brand-mark]')).toHaveLength(1);
    const link = $('a.brand-link');
    expect(link).toHaveLength(1);
    expect(link.attr('href')).toBe('/');
    expect(link.attr('aria-label')).toBe(`${BRAND_NAME} home`);
    expect(link.find('[data-brand-wordmark]')).toHaveLength(1);
  });

  it('BrandHeader keeps the name on phones unless it carries controls', () => {
    const bare = load(renderToStaticMarkup(createElement(BrandHeader)));
    expect(bare('[data-brand-wordmark]').attr('data-brand-wordmark')).toBe('always');
    const withControls = load(
      renderToStaticMarkup(createElement(BrandHeader, { rightSlot: createElement('button') })),
    );
    expect(withControls('[data-brand-wordmark]').attr('data-brand-wordmark')).toBe('from-sm');
  });

  it('the lockup is the mark and the wordmark, the slash a step quieter', () => {
    const $ = load(renderToStaticMarkup(createElement(BrandLockup)));
    expect($('svg[role="img"]')).toHaveLength(1);
    expect($('[data-brand-wordmark] > span').text()).toBe('/');
  });

  it('the Platform console topbar: the lockup once, then the crown', () => {
    // Called like the layout renders it (usePathname is mocked above).
    const $ = load(
      renderToStaticMarkup(
        AdminShell({ supportUnread: 0, children: createElement('p', null, 'x') }),
      ),
    );
    expect($('[data-brand-wordmark]')).toHaveLength(1);
    expect($('.admin-topbar > a.brand-link [data-brand-wordmark]')).toHaveLength(1);
    expect($('.admin-topbar-brand svg.lucide-crown')).toHaveLength(1);
    // "Platform console" from 640px up, "Console" on phones, so the mark
    // fits the phone topbar's first row (AdminShell.module.css).
    expect(
      $('.admin-topbar-brand > span')
        .map((_, el) => $(el).text())
        .get(),
    ).toEqual(['Platform console', 'Console']);
    const rules = loadCssFile('src/components/AdminShell.module.css');
    const display = (sel: string, wide: boolean) =>
      rules
        .filter((r) => r.selectors.includes(sel) && r.conditions.length === (wide ? 1 : 0))
        .flatMap((r) => r.decls.filter((d) => d.prop === 'display').map((d) => d.value));
    expect(display('.scopeLong', false)).toEqual(['none']);
    expect(display('.scopeLong', true)).toEqual(['inline']);
    expect(display('.scopeShort', true)).toEqual(['none']);
    expect(
      rules.find((r) => r.selectors.includes('.scopeLong') && r.conditions.length)?.conditions,
    ).toEqual(['@media (min-width: 640px)']);
  });
});

describe('the chrome draws icons, not emoji', () => {
  const EMOJI = /\p{Extended_Pictographic}/u;
  /** The frame every page sits in: shells, header, nav, palette, panels, backstops. */
  const CHROME = [
    ...walk('src/components').filter((f) => /\.(ts|tsx)$/.test(f)),
    'src/app/layout.tsx',
    'src/app/error.tsx',
    'src/app/global-error.tsx',
    'src/app/not-found.tsx',
    'src/app/admin/layout.tsx',
  ];

  it('budget: 0 emoji in the chrome', () => {
    expect(CHROME.length).toBeGreaterThan(20);
    const found = CHROME.flatMap((f) =>
      readFileSync(repoPath(f), 'utf8')
        .split('\n')
        .flatMap((line, i) => (EMOJI.test(line) ? [`${f}:${i + 1} ${line.trim()}`] : [])),
    );
    expect(found).toEqual([]);
  });

  it('the role icons are Lucide, one per workspace role', () => {
    expect(Object.keys(ROLE_ICONS).sort()).toEqual([...workspaceMemberRole.enumValues].sort());
    for (const role of workspaceMemberRole.enumValues) {
      const html = renderToStaticMarkup(createElement(RoleIcon, { role }));
      expect(html, role).toMatch(/^<svg[^>]*class="lucide[^"]*"[^>]*aria-hidden="true"/);
      expect(html).toContain(`data-role-icon="${role}"`);
    }
    expect(renderToStaticMarkup(createElement(RoleIcon, { role: 'super_admin' }))).toBe('');
    expect(renderToStaticMarkup(createElement(RoleIcon, { role: 'constructor' }))).toBe('');
  });

  it('the console tenant page shows roles with RoleIcon and plain option labels', () => {
    const src = readFileSync(repoPath('src/app/admin/workspaces/[id]/page.tsx'), 'utf8');
    expect(src).toContain('<RoleIcon role={member.role} />');
    expect(src).not.toMatch(/[👑🛡⭐👤👁]/u);
  });

  it('the workspace switcher shows a building for a membership', () => {
    const $ = load(
      renderToStaticMarkup(
        createElement(WorkspaceSwitcher, {
          workspaces: [
            {
              id: '1',
              name: 'Home',
              slug: 'home',
              role: 'owner',
              isActive: true,
              isArchived: false,
              isDefault: true,
              isGodMode: false,
            },
            {
              id: '2',
              name: 'Other',
              slug: 'other',
              role: 'member',
              isActive: false,
              isArchived: false,
              isDefault: false,
              isGodMode: false,
            },
          ],
        }),
      ),
    );
    expect($('.workspace-switcher-icon svg[data-icon="workspace"]')).toHaveLength(1);
    expect($('.workspace-switcher-icon').text()).toBe('');
  });
});
