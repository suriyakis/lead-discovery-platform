// I155: absolute URLs of this app come from the deployment, never from a
// hard-coded production host, and the in-app copy the audit found stale
// says what the code does.
//
// - appUrl: the configured origin (APP_URL, AUTH_URL, NEXTAUTH_URL), else
//   the origin the request came in on (as the reverse proxy reports it),
//   else localhost. The Stripe success, cancel and portal return URLs are
//   built with it, so a checkout started on localhost or a preview deploy
//   comes back there.
// - The landing page says AI scores records (rules are the fallback), and
//   the knowledge page says indexing exists (it ships, with Index now).

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appOrigin, appUrl, configuredAppOrigin, requestOrigin } from '@/lib/app-origin';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8');
const headersOf = (h: Record<string, string>) => new Headers(h);

describe('appUrl (I155)', () => {
  it('uses the configured origin first, whatever the request says', () => {
    const env = { APP_URL: 'https://staging.example.com/ignored/path' };
    expect(
      appUrl('/settings/billing?stripe=success', {
        env,
        headers: headersOf({ host: 'evil.example.net' }),
      }),
    ).toBe('https://staging.example.com/settings/billing?stripe=success');
    expect(appUrl('/onboarding', { env: { AUTH_URL: 'http://localhost:3200' } })).toBe(
      'http://localhost:3200/onboarding',
    );
  });

  it('falls back to the origin the request came in on, then to localhost', () => {
    const none = {};
    expect(configuredAppOrigin(none)).toBeNull();
    expect(
      appUrl('/onboarding?stripe=canceled', {
        env: none,
        headers: headersOf({
          host: '127.0.0.1:3001',
          'x-forwarded-host': 'preview.example.com',
          'x-forwarded-proto': 'https',
        }),
      }),
    ).toBe('https://preview.example.com/onboarding?stripe=canceled');
    expect(appUrl('/x', { env: none, headers: headersOf({ host: 'localhost:3200' }) })).toBe(
      'http://localhost:3200/x',
    );
    expect(appUrl('/x', { env: none, headers: headersOf({}) })).toBe('http://localhost:3000/x');
    expect(appUrl('/x', { env: none })).toBe('http://localhost:3000/x');
  });

  it('a loopback APP_URL (the base compose default) never beats a real origin', () => {
    // docker-compose.yml sets APP_URL=http://localhost:3000 and compose
    // merges it into the prod container; AUTH_URL names the public host.
    const prod = {
      NODE_ENV: 'production',
      APP_URL: 'http://localhost:3000',
      AUTH_URL: 'https://discover.example.com',
    };
    expect(configuredAppOrigin(prod)?.href).toBe('https://discover.example.com/');
    expect(appOrigin(prod).href).toBe('https://discover.example.com/');
    expect(appUrl('/settings/billing?stripe=success', { env: prod })).toBe(
      'https://discover.example.com/settings/billing?stripe=success',
    );
    // Outside production too, a real configured origin wins.
    const mixed = { APP_URL: 'http://127.0.0.1:3000', NEXTAUTH_URL: 'https://a.example.com' };
    expect(configuredAppOrigin(mixed)?.href).toBe('https://a.example.com/');
    // In production a lone loopback value is ignored: the request's origin is used.
    const lone = { NODE_ENV: 'production', APP_URL: 'http://localhost:3000' };
    expect(configuredAppOrigin(lone)).toBeNull();
    expect(
      appUrl('/onboarding', {
        env: lone,
        headers: headersOf({
          host: '127.0.0.1:3001',
          'x-forwarded-host': 'discover.example.com',
          'x-forwarded-proto': 'https',
        }),
      }),
    ).toBe('https://discover.example.com/onboarding');
    // In development a loopback value gives way to a real request host,
    // and is kept over a loopback one.
    const dev = { APP_URL: 'http://[::1]:3000' };
    expect(appUrl('/x', { env: dev, headers: headersOf({ host: 'preview.example.com' }) })).toBe(
      'https://preview.example.com/x',
    );
    expect(appUrl('/x', { env: dev, headers: headersOf({ host: 'localhost:3200' }) })).toBe(
      'http://[::1]:3000/x',
    );
  });

  it('reads the first proxy hop and refuses a host that is not one', () => {
    expect(
      requestOrigin(
        headersOf({
          'x-forwarded-host': 'a.example.com, b.example.com',
          'x-forwarded-proto': 'https, http',
        }),
      )?.href,
    ).toBe('https://a.example.com/');
    expect(requestOrigin(headersOf({ host: 'app.example.com' }))?.href).toBe(
      'https://app.example.com/',
    );
    expect(requestOrigin(headersOf({ host: 'bad host/path' }))).toBeNull();
    expect(
      requestOrigin(headersOf({ host: 'app.example.com', 'x-forwarded-proto': 'javascript' })),
    ).toBeNull();
  });

  it('no page or route under src/app hard-codes the production host', () => {
    const offenders: string[] = [];
    const app = path.join(ROOT, 'src/app');
    for (const f of readdirSync(app, { recursive: true, encoding: 'utf8' })) {
      if (!/\.tsx?$/.test(f)) continue;
      const text = read(path.join('src/app', f)).replace(/^\s*\/\/.*$/gm, '');
      if (text.includes('discover.nulife.pl')) offenders.push(f.split(path.sep).join('/'));
    }
    expect(offenders).toEqual([]);
    for (const f of [
      'src/app/(app)/onboarding/page.tsx',
      'src/app/(app)/settings/billing/page.tsx',
    ])
      expect(read(f), f).toMatch(/appUrl\('\/[\w/]+(\?stripe=success)?'/);
  });
});

describe('stale copy (I155)', () => {
  it('the landing page says AI scores records, with rules as the fallback', () => {
    const landing = read('src/app/page.tsx');
    expect(landing).not.toMatch(/deterministic rule engine scores/);
    expect(landing).toContain('AI scores each record per product profile');
  });

  it('the knowledge page says sources are indexed now, not in a future phase', () => {
    const knowledge = read('src/app/(app)/knowledge/page.tsx').replace(/\s+/g, ' ');
    expect(knowledge).not.toMatch(/Future RAG/);
    // KL-06: sources are indexed in the background as soon as they change.
    expect(knowledge).toContain('Each one is chunked and embedded in the background');
  });
});

describe('one origin rule for alert and mail links (I155 x PC-08 x PC-36)', () => {
  it('owner alerts link to the public origin, never a loopback APP_URL in production', async () => {
    const { readAlertConfig } = await import('@/lib/ops/alert-config');
    const prod = {
      NODE_ENV: 'production',
      NTFY_TOPIC: 'ls-origin-test',
      APP_URL: 'http://localhost:3000',
      AUTH_URL: 'https://discover.example.test/',
    };
    expect(readAlertConfig(prod).appUrl).toBe('https://discover.example.test');
    expect(
      readAlertConfig({ NTFY_TOPIC: 'ls-origin-test', APP_URL: 'https://a.example.test/' }).appUrl,
    ).toBe('https://a.example.test');
    expect(
      readAlertConfig({ NODE_ENV: 'production', NTFY_TOPIC: 'ls-origin-test' }).appUrl,
    ).toBeNull();
  });

  it('sent mail builds its pixel and unsubscribe links from appOrigin, not raw APP_URL', () => {
    const mail = read('src/lib/services/mail.ts');
    expect(mail).not.toMatch(/process\.env\.APP_URL/);
    expect(mail).toMatch(/const appUrl = appOrigin\(\)\.origin;/);
  });
});
