// PC-36 (I065) acceptance (5): the compose files describe the split, and
// the versioned deploy script rebuilds and recreates both services.
//
// The files are parsed with a YAML parser and checked against the rules
// the production host needs: docker-compose v1 (hyphenated; it validates
// the merged files itself, which the deploy script runs as its first step
// with `config -q`), each service's ports in exactly one file (compose
// merges port lists), and one environment for app and worker except ROLE.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const yaml = createRequire(import.meta.url)('js-yaml') as { load(source: string): unknown };

interface Service {
  build?: { context?: string; dockerfile?: string; args?: Record<string, string> };
  image?: string;
  command?: string[] | string;
  profiles?: string[];
  ports?: string[];
  environment?: Record<string, string>;
  env_file?: string[];
  volumes?: string[];
  depends_on?: Record<string, { condition: string }>;
  stop_grace_period?: string;
  restart?: string;
}
interface ComposeFile {
  version?: string;
  services: Record<string, Service>;
}

const base = yaml.load(read('docker-compose.yml')) as ComposeFile;
const prod = yaml.load(read('docker-compose.prod.yml')) as ComposeFile;
const DEPLOY_SCRIPT = 'scripts/deploy/deploy-agregat.sh';

/** What compose does with `-f docker-compose.yml -f docker-compose.prod.yml`
 *  for a service's environment: per-key merge, the later file wins. */
function mergedEnv(name: string): Record<string, string> {
  return {
    ...(base.services[name]?.environment ?? {}),
    ...(prod.services[name]?.environment ?? {}),
  };
}

describe('docker-compose.prod.yml: the worker service (PC-36)', () => {
  const app = prod.services.app!;
  const worker = prod.services.worker!;

  it('defines a worker that runs the bundled worker entry from the app image', () => {
    expect(worker).toBeDefined();
    expect(worker.command).toEqual(['node', 'worker/worker.cjs']);
    expect(worker.image).toBeTruthy();
    expect(worker.image).toBe(app.image);
    expect(worker.build).toEqual(app.build);
    expect(worker.restart).toBe('unless-stopped');
  });

  it('serves no HTTP: no ports for the worker in either file', () => {
    expect(worker.ports).toBeUndefined();
    expect(base.services.worker).toBeUndefined();
  });

  it('every service publishes its ports in exactly one file (compose merges port lists)', () => {
    for (const name of Object.keys(prod.services)) {
      const inBase = Boolean(base.services[name]?.ports?.length);
      const inProd = Boolean(prod.services[name]?.ports?.length);
      expect(inBase && inProd, `${name} publishes ports in both files`).toBe(false);
    }
  });

  it('app and worker get the same environment, except ROLE', () => {
    const appEnv = mergedEnv('app');
    const workerEnv = mergedEnv('worker');
    expect(appEnv.ROLE).toBe('web');
    expect(workerEnv.ROLE).toBe('worker');
    const withoutRole = (env: Record<string, string>) =>
      Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'ROLE'));
    expect(withoutRole(workerEnv)).toEqual(withoutRole(appEnv));
    expect(worker.env_file).toEqual(app.env_file);
    // The split needs the shared Redis queue, whatever .env says.
    expect(appEnv.JOB_QUEUE_PROVIDER).toBe('bullmq');
    expect(appEnv.NODE_ENV).toBe('production');
  });

  it('the base file no longer overrides APP_URL / NODE_ENV for production', () => {
    // They come from .env; set in the base file they leaked into prod
    // through the merge (APP_URL=http://localhost:3000 in sent mail links).
    expect(base.services.app?.environment?.APP_URL).toBeUndefined();
    expect(base.services.app?.environment?.NODE_ENV).toBeUndefined();
    expect(mergedEnv('app').APP_URL).toBeUndefined();
  });

  it('starts like app: same profile, waits for postgres and redis, shares the storage volume', () => {
    expect(worker.profiles).toEqual(base.services.app?.profiles);
    expect(worker.depends_on).toEqual({
      postgres: { condition: 'service_healthy' },
      redis: { condition: 'service_healthy' },
    });
    expect(worker.volumes).toContain('app-storage:/app/storage');
    expect(app.volumes).toContain('app-storage:/app/storage');
    expect(worker.stop_grace_period).toBe('30s');
  });

  it('stays within docker-compose v1 (1.28+) syntax', () => {
    const text = read('docker-compose.prod.yml');
    // No v2-only YAML tags or keys.
    expect(text).not.toMatch(/!reset|!override|\bdevelop:|\bpull_policy:|\binclude:/);
    expect(prod.version).toBeUndefined();
    expect(base.version).toBeUndefined();
  });
});

describe('docker/Dockerfile and package.json: the bundled worker (PC-36)', () => {
  it('builds the worker bundle and copies it next to server.js', () => {
    const dockerfile = read('docker/Dockerfile');
    expect(dockerfile).toMatch(/RUN pnpm build && pnpm build:worker/);
    expect(dockerfile).toMatch(
      /COPY --from=builder --chown=nextjs:nodejs \/app\/dist\/worker \.\/worker/,
    );
  });

  it('has the build and run scripts', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build:worker']).toBe('node scripts/build-worker.mjs');
    expect(pkg.scripts.worker).toBe('node dist/worker/worker.cjs');
  });
});

describe(`${DEPLOY_SCRIPT} (PC-36)`, () => {
  const script = path.join(root, DEPLOY_SCRIPT);

  it('is executable and valid bash', () => {
    expect(statSync(script).mode & 0o111).not.toBe(0);
    const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  function dryRun(...args: string[]) {
    const r = spawnSync('bash', [script, '--dry-run', ...args], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  const COMPOSE = 'docker-compose -f docker-compose.yml -f docker-compose.prod.yml';

  it('the dry run prints the command sequence: pull, validate, build once, recreate app + worker', () => {
    const lines = dryRun();
    const commands = lines.filter((l) => !l.startsWith('echo') && !l.startsWith('#'));
    const at = (pattern: RegExp) => {
      const i = commands.findIndex((l) => pattern.test(l));
      expect(i, `missing: ${pattern}`).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(lines.join('\n')).toContain(`COMPOSE="${COMPOSE}"`);
    const pull = at(/^git pull origin main$/);
    const sha = at(/^export BUILD_SHA=\$\(git rev-parse --short HEAD\)$/);
    const config = at(/^\$COMPOSE --profile app config -q$/);
    const build = at(/^\$COMPOSE build app 2>&1 \| tail -40$/);
    const up = at(/^\$COMPOSE up -d --no-build --force-recreate --no-deps app worker$/);
    const status = at(/^docker ps .*grep -E -- '\[-_\]\(app\|worker\)\[-_\]'$/);
    const health = at(/curl .*http:\/\/127\.0\.0\.1:3001\/api\/health$/);
    expect([pull, sha, config, build, up, status, health]).toEqual(
      [pull, sha, config, build, up, status, health].slice().sort((a, b) => a - b),
    );
    // v1 only: never the `docker compose` plugin syntax.
    expect(commands.some((l) => /docker compose /.test(l))).toBe(false);
    // No migration unless asked.
    expect(commands.some((l) => /db:migrate/.test(l))).toBe(false);
  });

  it('--migrate runs the host-side migration after the build and before the recreate', () => {
    const commands = dryRun('--migrate').filter((l) => !l.startsWith('echo'));
    const build = commands.findIndex((l) => l.includes('build app'));
    const migrate = commands.indexOf('pnpm db:migrate');
    const up = commands.findIndex((l) => l.includes('up -d --no-build'));
    expect(build).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(up);
  });

  it('refuses unknown options and unsafe overrides', () => {
    expect(spawnSync('bash', [script, '--force'], { encoding: 'utf8' }).status).toBe(2);
    const unsafe = spawnSync('bash', [script, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, DEPLOY_BRANCH: 'main; rm -rf /' },
    });
    expect(unsafe.status).toBe(2);
  });
});
