import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';

/**
 * THE OPERATIONS SCRIPTS RUN ON THE HOST, AND CAN (B7).
 *
 * `scripts/` is not in the application image, on purpose: the backup, the
 * restore drill and the RLS proof need a superuser connection, `psql` and
 * `pg_dump`, and none of that belongs in a container that serves traffic. So
 * they run on the production host, through scripts/host-run.sh, reaching
 * PostgreSQL over B5 (127.0.0.1:5432). docs/DEPLOYMENT.md §٤-ج.
 *
 * What was wrong before: the deployment guide ran `bootstrap:owner` with
 * `exec app`, which can only answer `Cannot find module`; nothing told the host
 * where its database was (.env.production names `postgres`, a Docker-internal
 * host) or gave it the superuser URL, so the documented cron line would have
 * failed every hour; the first-start seeds were missing; and `engines` allowed
 * a Node that cannot run the `.ts` scripts.
 *
 * And the superuser password never rides in a URL: backup.sh, restore-drill.sh
 * and prove-rls.mjs hand that URL to pg_dump/psql as an ARGUMENT, readable by
 * any local user in `ps` and /proc/<pid>/cmdline. It lives in ~/.pgpass, which
 * libpq reads itself; host-run.sh refuses a URL that carries it.
 *
 * And the build context (B7-n1): `COPY . .` in the Dockerfile's build stage
 * takes everything .dockerignore lets through, so a .env.production or a
 * decrypted backup in the checkout would sit in a layer of the builder's cache.
 * Rule 7 asks a model of Docker's matching which paths would be sent.
 *
 * The text rules below are re-broken in memory, in LF and CRLF, like the other
 * stack guards. host-run.sh itself is run for real, on Linux, which is the only
 * place it is meant to run.
 */

const root = process.cwd();
const lf = (text: string) => text.replace(/\r\n?/g, '\n');
const read = (path: string) => lf(readFileSync(join(root, path), 'utf8'));

type Files = {
  readonly dockerfile: string;
  readonly dockerignore: string;
  readonly gitignore: string;
  readonly packageJson: string;
  readonly lock: string;
  readonly deployment: string;
  readonly backupDoc: string;
  readonly hostExample: string;
  readonly prodExample: string;
  readonly prodCompose: string;
  readonly previewCompose: string;
  readonly devCompose: string;
  readonly readme: string;
  readonly runLocally: string;
  readonly scripts: Readonly<Record<string, string>>;
};

/** The host-run scripts whose environment this file guards. */
const HOST_SCRIPTS = [
  'backup.sh',
  'restore-drill.sh',
  'prove-rls.mjs',
  'bootstrap-owner.ts',
  'seed-catalog.ts',
  'seed-payment-methods.ts',
  'backup-ship.ts',
  'backup-fetch.ts',
] as const;

const FILES: Files = {
  dockerfile: read('Dockerfile'),
  dockerignore: read('.dockerignore'),
  gitignore: read('.gitignore'),
  packageJson: read('package.json'),
  lock: read('package-lock.json'),
  deployment: read('docs/DEPLOYMENT.md'),
  backupDoc: read('docs/BACKUP-AND-RESTORE.md'),
  hostExample: read('.env.host.example'),
  prodExample: read('.env.production.example'),
  prodCompose: read('docker-compose.prod.yml'),
  previewCompose: read('docker-compose.preview.yml'),
  devCompose: read('docker-compose.yml'),
  readme: read('README.md'),
  runLocally: read('docs/RUN-LOCALLY.md'),
  scripts: Object.fromEntries(HOST_SCRIPTS.map((name) => [name, read(`scripts/${name}`)])),
};

const crlf = (text: string) => lf(text).replace(/\n/g, '\r\n');
const asCrlf = (f: Files): Files => ({
  ...(Object.fromEntries(
    Object.entries(f).map(([k, v]) => [k, typeof v === 'string' ? crlf(v) : v]),
  ) as Omit<Files, 'scripts'>),
  scripts: Object.fromEntries(Object.entries(f.scripts).map(([k, v]) => [k, crlf(v)])),
});

/** Every path the RUNTIME stage of the Dockerfile copies into the image. */
function imagePaths(dockerfile: string): string[] {
  const runtime = lf(dockerfile).split(/^FROM .* AS runtime$/m)[1] ?? '';
  return [...runtime.matchAll(/^COPY\s+(?:--\S+\s+)*\S+\s+\.\/(\S*)\s*$/gm)].map((m) => m[1] ?? '');
}

/**
 * Is `path` kept out of the build context? A model of Docker's .dockerignore
 * rules (moby/patternmatcher), so the guard runs without Docker: each line is
 * trimmed, blanks and `#` lines are skipped, a leading `!` re-includes, and the
 * pattern loses a leading and trailing slash. `*` and `?` stay inside one path
 * segment, `**` crosses them, a pattern that matches a parent directory
 * matches everything under it, and the LAST matching line decides.
 *
 * It is a model, not Docker. It reproduces the examples Docker documents (see
 * the tests below), but character classes and escapes are not modelled — a
 * pattern using them is reported, not guessed at — and only listing a real
 * build context can show what a given builder actually sends (B8).
 */
type IgnoreRule = { readonly negate: boolean; readonly regex: RegExp };

function ignoreRules(dockerignore: string): IgnoreRule[] | null {
  const rules: IgnoreRule[] = [];
  for (const raw of lf(dockerignore).split('\n')) {
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1).trim();
    if (/[[\]\\]/.test(line)) return null;
    line = posix.normalize(line).replace(/^\/(?=.)/, '').replace(/(?<=.)\/$/, '');
    let source = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i] ?? '';
      if (ch === '*' && line[i + 1] === '*') {
        i += line[i + 2] === '/' ? 2 : 1;
        source += i === line.length - 1 ? '.*' : '(?:.*/)?';
      } else if (ch === '*') source += '[^/]*';
      else if (ch === '?') source += '[^/]';
      else source += ch.replace(/[.+^${}()|]/g, '\\$&');
    }
    rules.push({ negate, regex: new RegExp(`^${source}$`) });
  }
  return rules;
}

function ignored(rules: readonly IgnoreRule[], path: string): boolean {
  const parts = path.split('/');
  let result = false;
  for (const rule of rules) {
    const hit = rule.regex.test(path) || parts.slice(1).some((_, i) => rule.regex.test(parts.slice(0, i + 1).join('/')));
    if (hit) result = !rule.negate;
  }
  return result;
}

/**
 * What must never reach the builder. The env files are named the way an
 * operator would name them; the backup paths are where backup.sh and
 * backup:fetch write.
 */
const SECRET_PATHS = [
  '.env',
  '.env.production',
  '.env.staging',
  '.env.development',
  '.env.local',
  '.env.host.local',
  'docker/.env',
  'deploy/.env.production',
  'backups/20260914T084659Z/database.dump',
  'restored/x/database.dump',
  'restored/x/roles.sql',
  'id.pem',
  'deploy/tls/server.key',
  '.pgpass',
  'scripts/.pgpass',
  'uploads/originals/x.pdf',
] as const;

/** Everything under a directory, as context-relative paths. */
const filesUnder = (dir: string) =>
  readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => posix.join(relative(root, entry.parentPath).split(sep).join('/'), entry.name));

/**
 * What the build cannot do without: the files `npm run build` reads (its
 * prebuild guard included) and every file of the application and its assets.
 * The paths the runtime stage copies out of the build stage are added from the
 * Dockerfile itself in rule 7, so a new COPY is covered without editing this.
 */
const BUILD_INPUTS = [
  'package.json',
  'package-lock.json',
  'next.config.ts',
  'tsconfig.json',
  'postcss.config.mjs',
  'scripts/check-build-env.mjs',
  ...filesUnder('src'),
  ...filesUnder('assets'),
];

/** Names a KEY=VALUE file declares, commented-out lines excluded. */
function declared(env: string): Set<string> {
  return new Set([...lf(env).matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1] ?? ''));
}

export function violations(input: Files): string[] {
  const f: Files = {
    ...(Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? lf(v) : v]),
    ) as Omit<Files, 'scripts'>),
    scripts: Object.fromEntries(Object.entries(input.scripts).map(([k, v]) => [k, lf(v)])),
  };
  const found: string[] = [];
  const npmScripts = (JSON.parse(f.packageJson) as { scripts: Record<string, string> }).scripts;

  // 1. A documented `exec app npm run X` must find X's files inside the image.
  const inImage = imagePaths(f.dockerfile);
  for (const doc of [f.deployment, f.backupDoc]) {
    for (const [, script] of doc.matchAll(/exec app npm run ([\w:-]+)/g)) {
      const command = npmScripts[script ?? ''] ?? '';
      for (const [path] of command.matchAll(/\b(?:scripts|src)\/[\w./-]+/g)) {
        if (!inImage.some((copied) => copied !== '' && (path === copied || path.startsWith(`${copied}/`)))) {
          found.push(`exec-app-without-file:${script}`);
        }
      }
    }
  }

  // 2. The host scripts' database variables are documented for the host.
  const host = declared(f.hostExample);
  for (const [name, text] of Object.entries(f.scripts)) {
    if (name.startsWith('backup-ship') || name.startsWith('backup-fetch')) continue;
    const wanted = new Set([
      ...[...text.matchAll(/process\.env\.(DATABASE_[A-Z_]+)/g)].map((m) => m[1] ?? ''),
      ...[...text.matchAll(/\$\{(DATABASE_[A-Z_]+):\?/g)].map((m) => m[1] ?? ''),
    ]);
    if (wanted.size > 0 && ![...wanted].some((v) => host.has(v))) found.push(`host-env-missing:${name}`);
  }
  //    …and the backup credentials they require are documented where host-run.sh reads them.
  const prod = declared(f.prodExample);
  for (const name of ['backup-ship.ts', 'backup-fetch.ts']) {
    for (const [, key] of (f.scripts[name] ?? '').matchAll(/required\('(BACKUP_[A-Z0-9_]+)'\)/g)) {
      if (!prod.has(key ?? '')) found.push(`backup-env-missing:${key}`);
    }
  }

  // 3. Through B5, never the Docker-internal name, and B5 must exist.
  for (const [, key, host] of f.hostExample.matchAll(/^([A-Z_]+)=postgres(?:ql)?:\/\/[^@\n]*@([^/\n]+)/gm)) {
    if (host !== '127.0.0.1:5432') found.push(`host-url-not-b5:${key}`);
  }
  if (!f.prodCompose.includes("'127.0.0.1:5432:5432'")) found.push('b5-port-missing');

  // 3b. The superuser password never rides in a URL, so never in a PostgreSQL client's arguments.
  const superuser = f.hostExample.match(/^DATABASE_SUPERUSER_URL=(.*)$/m)?.[1] ?? '';
  if (/^[a-z]+:\/\/[^/@]*:[^/@]*@/.test(superuser) || /[?&]password=/.test(superuser)) {
    found.push('host-superuser-url-has-password');
  }
  for (const name of ['backup.sh', 'restore-drill.sh', 'prove-rls.mjs']) {
    const text = f.scripts[name] ?? '';
    if (/PGPASSWORD|postgres(?:ql)?:\/\/[^\s"'`@]*:\$\{?[A-Za-z_]/.test(text)) found.push(`script-builds-password-url:${name}`);
  }
  if (!/~\/\.pgpass/.test(f.hostExample) || !/\.pgpass/.test(f.deployment) || !/\.pgpass/.test(f.backupDoc)) {
    found.push('pgpass-undocumented');
  }

  // 4. No container reads the host file, the superuser URL or the backup keys.
  for (const [label, compose] of [
    ['prod', f.prodCompose],
    ['preview', f.previewCompose],
    ['dev', f.devCompose],
  ] as const) {
    if (/env_file|\.env\.host|DATABASE_SUPERUSER_URL|BACKUP_/.test(compose)) found.push(`compose-leaks-host-env:${label}`);
  }

  // 5. Every documented cron line goes through host-run.sh, which carries the environment.
  for (const doc of [f.deployment, f.backupDoc]) {
    for (const line of doc.split('\n')) {
      if (/^(?:[\d*/,-]+\s+){5}cd /.test(line) && !line.includes('bash scripts/host-run.sh')) {
        found.push('cron-without-host-run');
      }
    }
  }
  //    …and the first start includes the reference seeds, on the host.
  for (const seed of ['seed:catalog', 'seed:payment-methods', 'bootstrap:owner']) {
    if (!f.deployment.includes(`bash scripts/host-run.sh npm run ${seed}`)) found.push(`first-start-missing:${seed}`);
  }

  // 6. Node 22.6: the first release with --experimental-strip-types.
  const engines = (JSON.parse(f.packageJson) as { engines?: { node?: string } }).engines?.node;
  if (engines !== '>=22.6.0') found.push('engines-not-22.6');
  const lockEngines = (JSON.parse(f.lock) as { packages: Record<string, { engines?: { node?: string } }> })
    .packages['']?.engines?.node;
  if (lockEngines !== engines) found.push('lock-engines-drift');
  if (!f.readme.includes('Node.js 22.6+')) found.push('readme-node');
  if (!f.runLocally.includes('Node.js 22.6 أو أحدث')) found.push('run-locally-node');
  if (!f.deployment.includes('`>=22.6.0`')) found.push('deployment-node');

  // 7. The build context (B7-n1): no secret or backup in it, every build input in it.
  const rules = ignoreRules(f.dockerignore);
  if (rules === null) {
    found.push('dockerignore-unmodelled-pattern');
  } else {
    if (rules.some((rule) => rule.negate)) found.push('dockerignore-exception');
    for (const path of SECRET_PATHS) {
      if (!ignored(rules, path)) found.push(`context-includes:${path}`);
    }
    const copied = inImage.filter((path) => path !== '' && path !== '.next' && path !== 'node_modules');
    for (const path of [...BUILD_INPUTS, ...copied]) {
      if (ignored(rules, path)) found.push(`context-excludes-build-input:${path}`);
    }
  }
  //    …and a decrypted backup is never one `git add -A` away from a commit.
  if (!f.gitignore.split('\n').includes('/restored/')) found.push('restored-not-gitignored');

  return found;
}

const replace = (text: string, from: string | RegExp, to: string) => {
  const next = text.replace(from, to);
  if (next === text) throw new Error(`mutation did not apply: ${String(from)}`);
  return next;
};

describe('host tools (B7) — the files as they are', () => {
  it('break none of the rules', () => {
    expect(violations(FILES)).toEqual([]);
  });

  it('break none of the rules with CRLF line endings', () => {
    expect(violations(asCrlf(FILES))).toEqual([]);
  });
});

describe('host tools (B7) — each rule fails when its defect comes back', () => {
  const cases: Array<[string, (f: Files) => Files, string]> = [
    [
      'bootstrap:owner documented as `exec app` again',
      (f) => ({ ...f, deployment: `${f.deployment}\ndocker compose exec app npm run bootstrap:owner\n` }),
      'exec-app-without-file:bootstrap:owner',
    ],
    [
      'the superuser URL removed from the host example',
      (f) => ({ ...f, hostExample: replace(f.hostExample, /^DATABASE_SUPERUSER_URL=.*$/m, '') }),
      'host-env-missing:backup.sh',
    ],
    [
      'a backup key the shipper requires removed from .env.production.example',
      (f) => ({ ...f, prodExample: replace(f.prodExample, /^BACKUP_S3_BUCKET=.*$/m, '') }),
      'backup-env-missing:BACKUP_S3_BUCKET',
    ],
    [
      'a host URL pointed at the Docker-internal name',
      (f) => ({ ...f, hostExample: replace(f.hostExample, '@127.0.0.1:5432/engineering_marketplace\n\n# migrator', '@postgres:5432/engineering_marketplace\n\n# migrator') }),
      'host-url-not-b5:DATABASE_SUPERUSER_URL',
    ],
    [
      'B5 removed from the production compose file',
      (f) => ({ ...f, prodCompose: replace(f.prodCompose, "'127.0.0.1:5432:5432'", "'5432'") }),
      'b5-port-missing',
    ],
    [
      'the whole production env file handed to a container',
      (f) => ({ ...f, prodCompose: replace(f.prodCompose, '  app:\n', '  app:\n    env_file: .env.production\n') }),
      'compose-leaks-host-env:prod',
    ],
    [
      'env files with a suffix let back into the build context',
      (f) => ({ ...f, dockerignore: replace(f.dockerignore, '**/.env.*\n', '') }),
      'context-includes:.env.production',
    ],
    [
      'the host file let back into the build context',
      (f) => ({ ...f, dockerignore: replace(f.dockerignore, '**/.env.*\n', '') }),
      'context-includes:.env.host.local',
    ],
    [
      'a bare .env excluded at the root only',
      (f) => ({ ...f, dockerignore: replace(f.dockerignore, '**/.env\n', '.env\n') }),
      'context-includes:docker/.env',
    ],
    [
      'decrypted backups let into the build context',
      (f) => ({ ...f, dockerignore: replace(f.dockerignore, '\nrestored\n', '\n') }),
      'context-includes:restored/x/database.dump',
    ],
    [
      'private keys let into the build context',
      (f) => ({ ...f, dockerignore: replace(f.dockerignore, '**/*.pem\n', '') }),
      'context-includes:id.pem',
    ],
    [
      'the password file let into the build context',
      (f) => ({ ...f, dockerignore: replace(f.dockerignore, '**/.pgpass\n', '') }),
      'context-includes:.pgpass',
    ],
    [
      'an exception that re-includes the production env file',
      (f) => ({ ...f, dockerignore: `${f.dockerignore}!.env.production\n` }),
      'context-includes:.env.production',
    ],
    [
      'any exception at all',
      (f) => ({ ...f, dockerignore: `${f.dockerignore}!.env.example\n` }),
      'dockerignore-exception',
    ],
    [
      'a pattern the model cannot read',
      (f) => ({ ...f, dockerignore: `${f.dockerignore}.env.[ps]*\n` }),
      'dockerignore-unmodelled-pattern',
    ],
    [
      'the build-env guard excluded with scripts/',
      (f) => ({ ...f, dockerignore: `${f.dockerignore}scripts\n` }),
      'context-excludes-build-input:scripts/check-build-env.mjs',
    ],
    [
      'the application excluded',
      (f) => ({ ...f, dockerignore: `${f.dockerignore}src\n` }),
      'context-excludes-build-input:src/app/layout.tsx',
    ],
    [
      'the fonts excluded',
      (f) => ({ ...f, dockerignore: `${f.dockerignore}**/*.ttf\n` }),
      'context-excludes-build-input:assets/fonts/NotoNaskhArabic-Regular.ttf',
    ],
    [
      'the Next config excluded by an over-wide rule',
      (f) => ({ ...f, dockerignore: `${f.dockerignore}*.ts\n` }),
      'context-excludes-build-input:next.config.ts',
    ],
    [
      'a file the runtime stage copies excluded',
      (f) => ({ ...f, dockerignore: `${f.dockerignore}drizzle.config.ts\n` }),
      'context-excludes-build-input:drizzle.config.ts',
    ],
    [
      'decrypted backups no longer git-ignored',
      (f) => ({ ...f, gitignore: replace(f.gitignore, '/restored/\n', '') }),
      'restored-not-gitignored',
    ],
    [
      'the cron line without host-run.sh',
      (f) => ({ ...f, backupDoc: replace(f.backupDoc, 'cd /srv/enginora && bash scripts/host-run.sh npm run backup:hourly', 'cd /srv/enginora && npm run backup:hourly') }),
      'cron-without-host-run',
    ],
    [
      'seed:catalog dropped from the first start',
      (f) => ({ ...f, deployment: replace(f.deployment, 'bash scripts/host-run.sh npm run seed:catalog', 'npm run seed:catalog') }),
      'first-start-missing:seed:catalog',
    ],
    [
      'the superuser password put back into the example URL',
      (f) => ({ ...f, hostExample: replace(f.hostExample, 'postgresql://postgres@127.0.0.1', 'postgresql://postgres:<POSTGRES_SUPERUSER_PASSWORD>@127.0.0.1') }),
      'host-superuser-url-has-password',
    ],
    [
      'the superuser password passed as a query parameter',
      (f) => ({ ...f, hostExample: replace(f.hostExample, '5432/engineering_marketplace\n\n# migrator', '5432/engineering_marketplace?password=<x>\n\n# migrator') }),
      'host-superuser-url-has-password',
    ],
    [
      'a backup script building a URL around a password variable',
      (f) => ({ ...f, scripts: { ...f.scripts, 'backup.sh': `${f.scripts['backup.sh']}\npsql "postgresql://postgres:\${SUPER_PW}@127.0.0.1/x"\n` } }),
      'script-builds-password-url:backup.sh',
    ],
    [
      'the password handed to psql through PGPASSWORD',
      (f) => ({ ...f, scripts: { ...f.scripts, 'prove-rls.mjs': `${f.scripts['prove-rls.mjs']}\nprocess.env.PGPASSWORD = pw;\n` } }),
      'script-builds-password-url:prove-rls.mjs',
    ],
    [
      '.pgpass dropped from the deployment guide',
      (f) => ({ ...f, deployment: f.deployment.replace(/\.pgpass/g, '.netrc') }),
      'pgpass-undocumented',
    ],
    [
      'engines back to >=22',
      (f) => ({ ...f, packageJson: replace(f.packageJson, '"node": ">=22.6.0"', '"node": ">=22"') }),
      'engines-not-22.6',
    ],
    [
      'the lockfile engines left behind',
      (f) => ({ ...f, lock: replace(f.lock, '"node": ">=22.6.0"', '"node": ">=22"') }),
      'lock-engines-drift',
    ],
  ];

  it.each(cases)('%s', (_label, mutate, expected) => {
    expect(violations(mutate(FILES))).toContain(expected);
    expect(violations(asCrlf(mutate(FILES)))).toContain(expected);
  });
});

/**
 * The model behind rule 7, against the examples in Docker's own .dockerignore
 * documentation, plus the shapes the file above relies on. A model that got
 * these wrong would pass a .dockerignore Docker reads differently.
 */
describe('the .dockerignore model (rule 7)', () => {
  const check = (file: string, path: string) => {
    const rules = ignoreRules(file);
    if (rules === null) throw new Error('unmodelled pattern');
    return ignored(rules, path);
  };

  it.each([
    ['*/temp*', 'somedir/temporary.txt', true],
    ['*/temp*', 'somedir/temp', true],
    ['*/temp*', 'temporary.txt', false],
    ['*/*/temp*', 'somedir/subdir/temporary.txt', true],
    ['*/*/temp*', 'somedir/temporary.txt', false],
    ['temp?', 'tempa', true],
    ['temp?', 'temp', false],
    ['**/*.go', 'main.go', true],
    ['**/*.go', 'a/b/c.go', true],
    ['*.md\n!README.md', 'README.md', false],
    ['*.md\n!README.md', 'CHANGES.md', true],
    ['*.md\n!README*.md\nREADME-secret.md', 'README-secret.md', true],
    ['*.md\n!README*.md\nREADME-secret.md', 'README-public.md', false],
    ['restored', 'restored/x/database.dump', true],
    ['/restored/', 'restored/x/database.dump', true],
    ['restored', 'src/restored/x', false],
    ['**/.env', 'docker/.env', true],
    ['**/.env', '.env', true],
    ['**/.env.*', '.env.production', true],
    ['**/.env.*', '.envrc', false],
    ['.env', 'docker/.env', false],
    ['# .env', '.env', false],
    ['  .env  ', '.env', true],
    ['node_modules', 'node_modules/.bin/next', true],
    ['*.log', 'logs/app.log', false],
    ['secrets/**', 'secrets/a/b', true],
  ])('%j and %s → excluded: %s', (file, path, expected) => {
    expect(check(file, path)).toBe(expected);
  });
});

/**
 * host-run.sh, run for real in a throwaway copy of the layout it expects:
 * <dir>/scripts/host-run.sh beside <dir>/.env.host.local and .env.production.
 * The command it runs prints the variables that matter, so each case reads
 * what actually reached the child process. Linux only: the script is written
 * for the production host (GNU stat).
 */
describe.runIf(process.platform === 'linux')('scripts/host-run.sh', () => {
  let dir: string;
  const PROBE = `console.log(JSON.stringify(Object.fromEntries(['DATABASE_SUPERUSER_URL','DATABASE_MIGRATION_URL','DATABASE_URL','SESSION_SECRET','BACKUP_S3_BUCKET','MAIL_FROM','ODD','OWNER_USERNAME'].map(k=>[k,process.env[k]??null]))))`;

  const HOST = [
    '# host-only',
    'DATABASE_SUPERUSER_URL=postgresql://postgres@127.0.0.1:5432/engineering_marketplace',
    'DATABASE_MIGRATION_URL="postgresql://migrator:<pw>@127.0.0.1:5432/engineering_marketplace"',
    'ODD=$(touch pwned) <x> & y',
    '',
  ].join('\n');
  const APP = [
    'DATABASE_URL=postgresql://app_user:<pw>@postgres:5432/engineering_marketplace',
    'SESSION_SECRET=not-for-the-host',
    'MAIL_FROM=Enginora <no-reply@example.test>',
    'BACKUP_S3_BUCKET=enginora-backups',
    '',
  ].join('\n');

  const run = (env: Record<string, string> = {}, args: string[] = [process.execPath, '-e', PROBE]) => {
    const result = spawnSync('bash', [join(dir, 'scripts/host-run.sh'), ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: dir, NODE_ENV: 'test', ...env },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  const reset = () => {
    for (const name of ['.env.local', '.env.host.local', '.env.production', 'pwned', '.pgpass', 'elsewhere.pgpass']) {
      rmSync(join(dir, name), { force: true });
    }
    writeFileSync(join(dir, '.env.host.local'), HOST);
    chmodSync(join(dir, '.env.host.local'), 0o600);
    writeFileSync(join(dir, '.env.production'), APP);
    // HOME is `dir`, so this is the ~/.pgpass libpq would read. Dummy content.
    writeFileSync(join(dir, '.pgpass'), '127.0.0.1:5432:*:postgres:dummy-not-a-secret\n');
    chmodSync(join(dir, '.pgpass'), 0o600);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'host-run-'));
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(join(root, 'scripts/host-run.sh'), join(dir, 'scripts/host-run.sh'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('hands the command the host file and only the BACKUP_* keys of .env.production', () => {
    reset();
    const { status, stdout } = run({ OWNER_USERNAME: 'owner' });
    expect(status).toBe(0);
    const seen = JSON.parse(stdout) as Record<string, string | null>;
    expect(seen.DATABASE_SUPERUSER_URL).toBe('postgresql://postgres@127.0.0.1:5432/engineering_marketplace');
    expect(seen.DATABASE_MIGRATION_URL).toBe('postgresql://migrator:<pw>@127.0.0.1:5432/engineering_marketplace');
    expect(seen.BACKUP_S3_BUCKET).toBe('enginora-backups');
    // The application's own secrets and its Docker-internal URL stay behind.
    expect(seen.SESSION_SECRET).toBeNull();
    expect(seen.DATABASE_URL).toBeNull();
    expect(seen.MAIL_FROM).toBeNull();
    // What the operator exports passes through.
    expect(seen.OWNER_USERNAME).toBe('owner');
  });

  it('reads values and never executes them', () => {
    reset();
    const { status, stdout } = run();
    expect(status).toBe(0);
    expect((JSON.parse(stdout) as Record<string, string>).ODD).toBe('$(touch pwned) <x> & y');
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
  });

  it('refuses while .env.local exists', () => {
    reset();
    writeFileSync(join(dir, '.env.local'), 'DATABASE_SUPERUSER_URL=postgresql://postgres:postgres@localhost:5432/x\n');
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain('.env.local exists');
  });

  it('refuses without the host file', () => {
    reset();
    rmSync(join(dir, '.env.host.local'));
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain('Missing');
  });

  it('refuses a host file others can read', () => {
    reset();
    chmodSync(join(dir, '.env.host.local'), 0o644);
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain('mode 644');
  });

  it('refuses a line that is not KEY=VALUE, without printing it', () => {
    reset();
    writeFileSync(join(dir, '.env.host.local'), `${HOST}export SECRETISH=do-not-print\n`);
    chmodSync(join(dir, '.env.host.local'), 0o600);
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain('.env.host.local:5 is not KEY=VALUE');
    expect(stderr).not.toContain('do-not-print');
  });

  it.each([
    ['in the URL', 'postgresql://postgres:hunter2-not-real@127.0.0.1:5432/engineering_marketplace'],
    ['as a query parameter', 'postgresql://postgres@127.0.0.1:5432/engineering_marketplace?password=hunter2-not-real'],
  ])('refuses a superuser password %s, without printing it', (_label, url) => {
    reset();
    writeFileSync(join(dir, '.env.host.local'), HOST.replace(/^DATABASE_SUPERUSER_URL=.*$/m, `DATABASE_SUPERUSER_URL=${url}`));
    chmodSync(join(dir, '.env.host.local'), 0o600);
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain('carries a password');
    expect(stderr).not.toContain('hunter2');
  });

  it('refuses without a password file', () => {
    reset();
    rmSync(join(dir, '.pgpass'));
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain('.pgpass — the superuser password lives there');
  });

  it('refuses a password file others can read, as libpq would ignore it', () => {
    reset();
    chmodSync(join(dir, '.pgpass'), 0o644);
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain('.pgpass is mode 644');
    expect(stderr).not.toContain('dummy-not-a-secret');
  });

  // Only root can give a file to another user, so this runs where the tests run
  // as root (this repository's development container) and is skipped elsewhere.
  it.runIf(process.getuid?.() === 0)('refuses a password file that belongs to someone else', () => {
    reset();
    chownSync(join(dir, '.pgpass'), 65534, 65534);
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain('does not belong to the user running this command');
  });

  it('honours PGPASSFILE instead of ~/.pgpass', () => {
    reset();
    rmSync(join(dir, '.pgpass'));
    writeFileSync(join(dir, 'elsewhere.pgpass'), '127.0.0.1:5432:*:postgres:dummy-not-a-secret\n');
    chmodSync(join(dir, 'elsewhere.pgpass'), 0o600);
    expect(run({ PGPASSFILE: join(dir, 'elsewhere.pgpass') }).status).toBe(0);
  });

  it('passes the command’s exit status through, and wants a command', () => {
    reset();
    expect(run({}, [process.execPath, '-e', 'process.exit(7)']).status).toBe(7);
    expect(run({}, []).status).toBe(2);
  });
});
