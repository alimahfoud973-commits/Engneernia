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
 * place it is meant to run. So is the Dockerfile's install step (rule 8), whose
 * text decides how the build answers a lost connection: reading it is not
 * enough to know what a shell does with it.
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

/** The mount the image's one `npm ci` runs under (rule 8). */
const NPM_CACHE_MOUNT = 'RUN --mount=type=cache,target=/root/.npm ';

/**
 * Every RUN of the deps stage that installs, as one line each: continuation
 * lines joined, the way Docker hands them to `/bin/sh -c`. Docker keeps the
 * next line's indentation where this leaves one space; the step quotes nothing
 * across a line break, so the shell reads the two the same.
 */
function installSteps(dockerfile: string): string[] {
  const deps = lf(dockerfile).split(/^FROM .* AS deps$/m)[1]?.split(/^FROM /m)[0] ?? '';
  return deps
    .replace(/\s*\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => /^RUN\b.*\bnpm ci\b/.test(line));
}

/**
 * The install step, statement by statement (rule 8). Whatever is not one of
 * these statements, in this order, is not the step that was measured: a
 * dropped bound, a failure answered with `exit 0`, stdout sent to /dev/null,
 * a code matched anywhere on a line instead of as the whole line.
 */
const INSTALL_SHAPE = new RegExp(
  `^${[
    String.raw`err=\$\(mktemp\) \|\| exit 1;`,
    String.raw`trap 'rm -f "\$err"' EXIT;`,
    String.raw`n=1; max=(?<max>\d+); pause=(?<pause>\d+);`,
    String.raw`while :; do`,
    String.raw`npm ci(?: --[a-z-]+(?:=\d+)?)+ 2>"\$err"; rc=\$\?;`,
    String.raw`cat "\$err" >&2;`,
    String.raw`\[ "\$rc" -eq 0 \] && exit 0;`,
    String.raw`\[ "\$\(grep -c '\^npm error code ' "\$err"\)" = 1 \] \|\| exit "\$rc";`,
    String.raw`grep -qxE 'npm error code \((?<codes>[A-Z0-9_|]+)\)' "\$err" \|\| exit "\$rc";`,
    String.raw`\[ "\$n" -lt "\$max" \] \|\| exit "\$rc";`,
    // The notice: plain words and the three counters, nothing the shell would run.
    'echo "(?:[^"`\\\\$]|\\$(?:n|max|pause)\\b)*" >&2;',
    String.raw`n=\$\(\(n \+ 1\)\); sleep "\$pause";`,
    'done',
  ].join(' ')}$`,
);

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

  // 8. `npm ci` survives a slow, unstable link (P3-3 on the owner's laptop:
  //    20 to 60 KB/s, and ECONNRESET after 35 minutes on 2026-11-06 and after
  //    21 on 2026-11-13; `next` alone is 43.7 MB).
  //
  //    Its cache is a BuildKit cache mount, so an interrupted install keeps
  //    every tarball it finished (measured: 79.63 MB left by the failed run of
  //    2026-11-13). The mount never reaches an image: nothing may copy it.
  //
  //    The --fetch-retry values are floors: they are what npm does about a
  //    request that fails BEFORE its response headers. They do nothing for a
  //    connection lost DURING a tarball: npm 10.9.9 makes one request and the
  //    install exits (measured against a registry that cuts the body: 1
  //    request with these values, 6 when the cut comes before the headers).
  //    That loss is what the laptop sees, so the step repeats the install
  //    itself, and its shape is fixed here statement by statement: a bound, a
  //    pause, the two codes such a loss ends with, npm's own status on every
  //    other path, stderr written back out, the temporary file removed. The
  //    behavioural tests at the end of this file run the same text.
  //
  //    --fetch-timeout has a CEILING as well as a floor. It is an idle limit
  //    (a 12 s download passes a 3 s limit), so a large value protects no slow
  //    download and only decides how long a silent connection is waited on.
  //    It was 3600000 here, with a floor to keep it there, on the belief that
  //    it bounded the whole transfer.
  const installs = installSteps(f.dockerfile);
  const install = installs[0] ?? '';
  if (installs.length !== 1 || !install.startsWith(NPM_CACHE_MOUNT)) found.push('npm-ci-cache-mount');
  const option = (name: string) => Number(new RegExp(` --${name}=(\\d+)(?= )`).exec(install)?.[1] ?? Number.NaN);
  const fetchTimeout = option('fetch-timeout');
  if (
    !/ --no-audit\b/.test(install) || !/ --no-fund\b/.test(install) || !/ --prefer-offline\b/.test(install)
    || !(option('fetch-retries') >= 5) || !(option('fetch-retry-mintimeout') >= 20_000)
    || !(option('fetch-retry-maxtimeout') >= 120_000)
    || !(fetchTimeout >= 60_000 && fetchTimeout <= 600_000)
  ) {
    found.push('npm-ci-network-options');
  }
  const loop = INSTALL_SHAPE.exec(install.slice(NPM_CACHE_MOUNT.length))?.groups;
  if (!install.startsWith(NPM_CACHE_MOUNT) || loop === undefined) {
    found.push('npm-ci-retry-loop');
  } else {
    // Two runs is the least that retries at all; ten is where a link that
    // cannot hold a connection should be reported, not waited on.
    const max = Number(loop.max);
    const pause = Number(loop.pause);
    if (!(max >= 2 && max <= 10) || !(pause >= 1 && pause <= 300)) found.push('npm-ci-retry-bound');
    // Exactly the codes npm does not retry itself. One more (ENOTFOUND, E404,
    // EUSAGE…) repeats a failure that no second run can change.
    if ((loop.codes ?? '').split('|').sort().join('|') !== 'ECONNRESET|EIDLETIMEOUT') found.push('npm-ci-retry-codes');
  }
  if ((f.dockerfile.match(/\bnpm ci\b/g) ?? []).length !== 1 || /^COPY\b.*\/root\/\.npm/m.test(f.dockerfile)) {
    found.push('npm-cache-reaches-image');
  }

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
    // rule 8, on an in-memory copy of the Dockerfile
    ...((): Array<[string, (f: Files) => Files, string]> => {
      const step = /^RUN --mount=type=cache,target=\/root\/\.npm \\\n(?:.*\\\n)* {4}done$/m;
      const dockerfile = (f: Files, from: string | RegExp, to: string) => ({ ...f, dockerfile: replace(f.dockerfile, from, to) });
      const OPTIONS = '--fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000';
      // The step as PR #35 left it: the mount and the options, one run.
      const ONE_RUN = [
        'RUN --mount=type=cache,target=/root/.npm \\',
        '    npm ci --no-audit --no-fund --prefer-offline \\',
        `      ${OPTIONS} \\`,
        '      --fetch-timeout=300000',
      ].join('\n');
      const CODES = "grep -qxE 'npm error code (ECONNRESET|EIDLETIMEOUT)' \"$err\"";
      return [
        ['npm ci as it was before P3-3 (no cache, no options)',
          (f) => dockerfile(f, step, 'RUN npm ci --no-audit --no-fund'), 'npm-ci-cache-mount'],
        ['npm ci as it was before P3-3, the options too',
          (f) => dockerfile(f, step, 'RUN npm ci --no-audit --no-fund'), 'npm-ci-network-options'],
        ['npm ci as it was before P3-3, with nothing repeating it',
          (f) => dockerfile(f, step, 'RUN npm ci --no-audit --no-fund'), 'npm-ci-retry-loop'],
        ['the repeat removed: one run under the mount, as PR #35 left it',
          (f) => dockerfile(f, step, ONE_RUN), 'npm-ci-retry-loop'],
        ['the cache mount dropped, the step kept',
          (f) => dockerfile(f, 'RUN --mount=type=cache,target=/root/.npm \\\n    err=', 'RUN err='), 'npm-ci-cache-mount'],
        ['the cache mounted somewhere npm does not look',
          (f) => dockerfile(f, 'target=/root/.npm', 'target=/tmp/npm'), 'npm-ci-cache-mount'],
        ['a bind mount instead of a cache',
          (f) => dockerfile(f, '--mount=type=cache,', '--mount=type=bind,'), 'npm-ci-cache-mount'],
        ['the idle timeout back to an hour',
          (f) => dockerfile(f, '--fetch-timeout=300000', '--fetch-timeout=3600000'), 'npm-ci-network-options'],
        ['the idle timeout shorter than a slow link pauses',
          (f) => dockerfile(f, '--fetch-timeout=300000', '--fetch-timeout=5000'), 'npm-ci-network-options'],
        ['the timeout dropped',
          (f) => dockerfile(f, '        --fetch-timeout=300000 2>', '        2>'), 'npm-ci-network-options'],
        ['retries back to npm’s 2',
          (f) => dockerfile(f, '--fetch-retries=5', '--fetch-retries=2'), 'npm-ci-network-options'],
        ['retry waits shortened',
          (f) => dockerfile(f, '--fetch-retry-maxtimeout=120000', '--fetch-retry-maxtimeout=60000'), 'npm-ci-network-options'],
        ['--prefer-offline dropped',
          (f) => dockerfile(f, ' --prefer-offline', ''), 'npm-ci-network-options'],
        ['the bound removed: it repeats for ever',
          (f) => dockerfile(f, '      [ "$n" -lt "$max" ] || exit "$rc"; \\\n', ''), 'npm-ci-retry-loop'],
        ['a hundred runs',
          (f) => dockerfile(f, 'max=6;', 'max=100;'), 'npm-ci-retry-bound'],
        ['one run, called a retry',
          (f) => dockerfile(f, 'max=6;', 'max=1;'), 'npm-ci-retry-bound'],
        ['no pause between runs',
          (f) => dockerfile(f, 'pause=30;', 'pause=0;'), 'npm-ci-retry-bound'],
        ['the sleep removed',
          (f) => dockerfile(f, ' sleep "$pause";', ''), 'npm-ci-retry-loop'],
        ['every failure repeated: both checks of the code removed',
          (f) => dockerfile(f, /^ {6}\[ "\$\(grep -c .*\\\n {6}grep -qxE .*\\\n/m, ''), 'npm-ci-retry-loop'],
        ['a second code line no longer stops it',
          (f) => dockerfile(f, /^ {6}\[ "\$\(grep -c .*\\\n/m, ''), 'npm-ci-retry-loop'],
        ['the code matched anywhere on a line, not as the whole line',
          (f) => dockerfile(f, 'grep -qxE', 'grep -qE'), 'npm-ci-retry-loop'],
        ['a DNS failure repeated',
          (f) => dockerfile(f, CODES, CODES.replace('EIDLETIMEOUT', 'EIDLETIMEOUT|ENOTFOUND')), 'npm-ci-retry-codes'],
        ['a missing package repeated',
          (f) => dockerfile(f, CODES, CODES.replace('EIDLETIMEOUT', 'EIDLETIMEOUT|E404')), 'npm-ci-retry-codes'],
        ['a lockfile error repeated',
          (f) => dockerfile(f, CODES, CODES.replace('ECONNRESET', 'EUSAGE|ECONNRESET')), 'npm-ci-retry-codes'],
        ['the stalled connection no longer repeated',
          (f) => dockerfile(f, CODES, CODES.replace('|EIDLETIMEOUT', '|ETIMEDOUT')), 'npm-ci-retry-codes'],
        ['the last failure answered with success',
          (f) => dockerfile(f, '[ "$n" -lt "$max" ] || exit "$rc";', '[ "$n" -lt "$max" ] || exit 0;'), 'npm-ci-retry-loop'],
        ['a failure that leaves the loop instead of the step',
          (f) => dockerfile(f, `${CODES} || exit "$rc";`, `${CODES} || break;`), 'npm-ci-retry-loop'],
        ['the step forgiven after the loop',
          (f) => dockerfile(f, /^ {4}done$/m, '    done || true'), 'npm-ci-retry-loop'],
        ['npm’s stderr read for the code and never shown',
          (f) => dockerfile(f, '      cat "$err" >&2; \\\n', ''), 'npm-ci-retry-loop'],
        ['npm’s stdout thrown away',
          (f) => dockerfile(f, '2>"$err"; rc=$?;', '>/dev/null 2>"$err"; rc=$?;'), 'npm-ci-retry-loop'],
        ['the temporary file left behind',
          (f) => dockerfile(f, ' trap \'rm -f "$err"\' EXIT;', ''), 'npm-ci-retry-loop'],
        ['a fixed path instead of mktemp',
          (f) => dockerfile(f, 'err=$(mktemp) || exit 1;', 'err=/tmp/npm-ci.err;'), 'npm-ci-retry-loop'],
        ['the notice runs a command',
          (f) => dockerfile(f, 'echo "install run $n of $max', 'echo "$(date) install run $n of $max'), 'npm-ci-retry-loop'],
        ['the npm cache copied into the runtime image',
          (f) => dockerfile(f, /^USER nextjs$/m, 'COPY --from=deps /root/.npm /home/nextjs/.npm\nUSER nextjs'), 'npm-cache-reaches-image'],
        ['a second npm ci, without the mount',
          (f) => dockerfile(f, /^RUN npm run build$/m, 'RUN npm ci && npm run build'), 'npm-cache-reaches-image'],
      ];
    })(),
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

/**
 * The install step of the Dockerfile, run for real (rule 8): the text of the
 * RUN, handed to `sh -c` as Docker hands it, with an `npm` and a `sleep` on
 * PATH that play a script and record what they were given. So each case reads
 * what the step DID: how many times it ran npm, with which arguments, how long
 * it asked to wait, what it wrote, what it left in TMPDIR and how it exited.
 *
 * The numbers are the owner's decision, written out and not read back from the
 * Dockerfile: six runs in all, the first included, thirty seconds apart.
 *
 * Linux only: the image is Debian, whose /bin/sh is dash, as it is on the CI
 * runners. The last cases break the step on purpose, to show that the cases
 * before them can tell.
 */
describe.runIf(process.platform === 'linux')('the Dockerfile install step, run for real (rule 8)', () => {
  type Run = { readonly rc: number; readonly stdout?: string; readonly stderr?: string };
  let dir: string;
  let seq = 0;

  const STEP = installSteps(FILES.dockerfile)[0]?.slice(NPM_CACHE_MOUNT.length) ?? '';
  const ARGS = [
    'ci', '--no-audit', '--no-fund', '--prefer-offline',
    '--fetch-retries=5', '--fetch-retry-mintimeout=20000', '--fetch-retry-maxtimeout=120000',
    '--fetch-timeout=300000',
  ];

  // The n-th call plays the n-th run of the plan; the last run repeats.
  const NPM_STUB = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const at = (name) => path.join(process.env.STUB, name);",
    "const calls = fs.existsSync(at('calls.json')) ? JSON.parse(fs.readFileSync(at('calls.json'), 'utf8')) : [];",
    'calls.push(process.argv.slice(2));',
    "fs.writeFileSync(at('calls.json'), JSON.stringify(calls));",
    "const plan = JSON.parse(fs.readFileSync(at('plan.json'), 'utf8'));",
    'const run = plan[Math.min(calls.length, plan.length) - 1];',
    "fs.writeSync(1, run.stdout ?? '');",
    "fs.writeSync(2, run.stderr ?? '');",
    'process.exit(run.rc);',
    '',
  ].join('\n');

  /** What npm 10.9.9 writes when a connection is lost during a tarball. */
  const lost = (code = 'ECONNRESET', rc = 1) => ({
    rc,
    stderr: `npm error code ${code}\nnpm error network aborted\nnpm error A complete log of this run can be found in: /root/.npm/_logs/debug-0.log\n`,
  });
  const failed = (code: string, rc = 1) => ({ rc, stderr: `npm error code ${code}\nnpm error this is about ${code}\n` });
  const DONE = {
    rc: 0,
    stdout: 'added 2 packages in 1s\n',
    stderr: 'npm warn deprecated left-pad@1.0.0: use String.prototype.padStart()\n',
  } satisfies Run;

  const play = (plan: readonly Run[], step: string = STEP, env: Record<string, string> = {}) => {
    seq += 1;
    const work = join(dir, String(seq));
    const [bin, state, tmp] = ['bin', 'state', 'tmp'].map((name) => join(work, name)) as [string, string, string];
    for (const made of [bin, state, tmp]) mkdirSync(made, { recursive: true });
    writeFileSync(join(state, 'plan.json'), JSON.stringify(plan));
    writeFileSync(join(bin, 'npm.js'), NPM_STUB);
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec '${process.execPath}' '${join(bin, 'npm.js')}' "$@"\n`);
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$STUB/sleeps"\n');
    chmodSync(join(bin, 'npm'), 0o755);
    chmodSync(join(bin, 'sleep'), 0o755);
    const result = spawnSync('sh', ['-c', step], {
      cwd: work,
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, STUB: state, TMPDIR: tmp, NODE_ENV: 'test', ...env },
    });
    const calls = existsSync(join(state, 'calls.json'))
      ? (JSON.parse(readFileSync(join(state, 'calls.json'), 'utf8')) as string[][])
      : [];
    const sleeps = existsSync(join(state, 'sleeps'))
      ? readFileSync(join(state, 'sleeps'), 'utf8').split('\n').filter((line) => line !== '')
      : [];
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, sleeps, left: readdirSync(tmp) };
  };
  const count = (text: string, part: string) => text.split(part).length - 1;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'install-step-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is the step rule 8 describes', () => {
    expect(INSTALL_SHAPE.test(STEP)).toBe(true);
  });

  it('runs npm once when it succeeds, with the arguments rule 8 demands, and passes both streams on', () => {
    const { status, stdout, stderr, calls, sleeps, left } = play([DONE]);
    expect(status).toBe(0);
    expect(calls).toEqual([ARGS]);
    expect(sleeps).toEqual([]);
    expect(stdout).toBe(DONE.stdout);
    expect(stderr).toBe(DONE.stderr);
    expect(left).toEqual([]);
  });

  it('repeats a connection lost during a tarball, and finishes when npm does', () => {
    const { status, stdout, stderr, calls, sleeps, left } = play([lost(), lost(), DONE]);
    expect(status).toBe(0);
    expect(calls).toEqual([ARGS, ARGS, ARGS]);
    expect(sleeps).toEqual(['30', '30']);
    expect(stdout).toBe(DONE.stdout);
    // Everything npm wrote, in the order it wrote it, each run's own text
    // before the notice that the run is being repeated.
    expect(stderr).toBe([
      lost().stderr,
      'install run 1 of 6 lost its connection; the cache keeps what finished. Next run in 30 s.\n',
      lost().stderr,
      'install run 2 of 6 lost its connection; the cache keeps what finished. Next run in 30 s.\n',
      DONE.stderr,
    ].join(''));
    expect(left).toEqual([]);
  });

  it('repeats a connection that went silent (EIDLETIMEOUT)', () => {
    const { status, calls, sleeps, left } = play([lost('EIDLETIMEOUT'), DONE]);
    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual(['30']);
    expect(left).toEqual([]);
  });

  it('stops after six runs in all, the first included, with npm’s own exit status', () => {
    const { status, stdout, stderr, calls, sleeps, left } = play([lost('ECONNRESET', 7)]);
    expect(status).toBe(7);
    expect(calls).toEqual([ARGS, ARGS, ARGS, ARGS, ARGS, ARGS]);
    expect(sleeps).toEqual(['30', '30', '30', '30', '30']);
    expect(stdout).toBe('');
    expect(count(stderr, 'npm error code ECONNRESET\n')).toBe(6);
    expect(count(stderr, 'npm error network aborted\n')).toBe(6);
    expect(stderr).toContain('install run 5 of 6 lost its connection');
    // The sixth failure is the end: nothing announces a seventh run.
    expect(stderr).not.toContain('install run 6 of 6');
    expect(stderr.endsWith(lost().stderr)).toBe(true);
    expect(left).toEqual([]);
  });

  it.each([
    ['a package that is not there', 'E404'],
    ['a tarball that is not the one the lockfile names', 'EINTEGRITY'],
    ['a lockfile out of step with package.json', 'EUSAGE'],
    ['a version that does not exist', 'ETARGET'],
    ['a lockfile that is not JSON', 'EJSONPARSE'],
    ['a name that does not resolve', 'ENOTFOUND'],
    ['a resolver that gave up for now', 'EAI_AGAIN'],
    ['headers that never came, after npm’s own six tries', 'FETCH_ERROR'],
    ['a connection that never opened', 'ETIMEDOUT'],
    ['a connection refused', 'ECONNREFUSED'],
    ['a full disk', 'ENOSPC'],
  ])('does not repeat %s (%s)', (_label, code) => {
    const { status, stdout, stderr, calls, sleeps, left } = play([failed(code, 3), DONE]);
    expect(status).toBe(3);
    expect(calls).toEqual([ARGS]);
    expect(sleeps).toEqual([]);
    expect(stdout).toBe('');
    expect(stderr).toBe(failed(code, 3).stderr);
    expect(left).toEqual([]);
  });

  it.each([
    ['inside a warning', 'npm warn tar TAR_ENTRY_ERROR npm error code ECONNRESET\nnpm error code E404\n'],
    ['inside a warning, with no code line at all', 'npm warn retry will retry, npm error code ECONNRESET\n'],
    ['with more after it on the line', 'npm error code ECONNRESET and then some\n'],
    ['as the start of a longer code', 'npm error code ECONNRESETX\n'],
    ['indented', '  npm error code ECONNRESET\n'],
    ['coloured', '\u001b[31mnpm error\u001b[39m code ECONNRESET\n'],
    ['in the wording npm used before 10', 'npm ERR! code ECONNRESET\n'],
    ['beside a second code', 'npm error code ECONNRESET\nnpm error code EUSAGE\n'],
    ['twice', 'npm error code ECONNRESET\nnpm error code ECONNRESET\n'],
    ['in lower case', 'npm error code econnreset\n'],
  ])('does not repeat when the code is only %s', (_label, text) => {
    const { status, stderr, calls, sleeps, left } = play([{ rc: 1, stderr: text }, DONE]);
    expect(status).toBe(1);
    expect(calls).toEqual([ARGS]);
    expect(sleeps).toEqual([]);
    expect(stderr).toBe(text);
    expect(left).toEqual([]);
  });

  it('does not repeat a failure that names no code (a killed process)', () => {
    const { status, calls, sleeps, left } = play([{ rc: 137, stderr: 'Killed\n' }, DONE]);
    expect(status).toBe(137);
    expect(calls).toEqual([ARGS]);
    expect(sleeps).toEqual([]);
    expect(left).toEqual([]);
  });

  it('does not repeat a failure that wrote nothing', () => {
    const { status, stderr, calls, left } = play([{ rc: 1 }, DONE]);
    expect(status).toBe(1);
    expect(calls).toEqual([ARGS]);
    expect(stderr).toBe('');
    expect(left).toEqual([]);
  });

  it('believes npm’s exit status over its words: 0 is success whatever was written', () => {
    const { status, calls, sleeps } = play([{ rc: 0, stderr: 'npm error code ECONNRESET\n' }]);
    expect(status).toBe(0);
    expect(calls).toEqual([ARGS]);
    expect(sleeps).toEqual([]);
  });

  it('fails a different way on a later run with that run’s status, not the first one’s', () => {
    const { status, stderr, calls, sleeps, left } = play([lost('ECONNRESET', 1), failed('EINTEGRITY', 4), DONE]);
    expect(status).toBe(4);
    expect(calls).toEqual([ARGS, ARGS]);
    expect(sleeps).toEqual(['30']);
    expect(stderr.endsWith(failed('EINTEGRITY', 4).stderr)).toBe(true);
    expect(left).toEqual([]);
  });

  it('never runs npm if it cannot make its temporary file', () => {
    const { status, calls } = play([DONE], STEP, { TMPDIR: join(dir, 'no-such-directory') });
    expect(status).toBe(1);
    expect(calls).toEqual([]);
  });

  // --- the step broken on purpose: each defect is one the cases above catch ---

  it('the step as PR #35 left it does NOT survive a lost connection', () => {
    const { status, calls } = play([lost(), DONE], `npm ${ARGS.join(' ')}`);
    expect(status).toBe(1);
    expect(calls).toEqual([ARGS]);
  });

  it('without the two checks of the code, a lockfile error is run six times', () => {
    const broken = replace(STEP, /\[ "\$\(grep -c .*? \|\| exit "\$rc"; grep -qxE .*? \|\| exit "\$rc"; /, '');
    const { status, calls } = play([failed('EUSAGE')], broken);
    expect(status).toBe(1);
    expect(calls).toHaveLength(6);
  });

  it('matched anywhere on the line, a longer code is taken for a lost connection', () => {
    const broken = replace(STEP, 'grep -qxE', 'grep -qE');
    expect(play([{ rc: 1, stderr: 'npm error code ECONNRESETX\n' }], broken).calls).toHaveLength(6);
  });

  it('with `exit 0` on the last run, six failures become a success', () => {
    const broken = replace(STEP, '[ "$n" -lt "$max" ] || exit "$rc";', '[ "$n" -lt "$max" ] || exit 0;');
    const { status, calls } = play([lost()], broken);
    expect(status).toBe(0);
    expect(calls).toHaveLength(6);
  });

  it('without the trap, the temporary file outlives the step', () => {
    const broken = replace(STEP, ' trap \'rm -f "$err"\' EXIT;', '');
    expect(play([DONE], broken).left).toHaveLength(1);
    expect(play([failed('E404')], broken).left).toHaveLength(1);
  });

  it('without `cat`, npm’s error never reaches the build log', () => {
    const broken = replace(STEP, ' cat "$err" >&2;', '');
    expect(play([failed('E404')], broken).stderr).toBe('');
  });
});
