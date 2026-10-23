import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * NO DATABASE IS BORN WITH A PUBLISHED PASSWORD (B6).
 *
 * docker/postgres/init/01-roles.sql is shared by every environment: the
 * production and preview compose files mount its directory, CI and
 * scripts/dev-db.sh run it. It used to create migrator and app_user WITH the
 * passwords that sit in this public repository, so every new database —
 * production included — accepted them until somebody rotated them by hand.
 *
 * Now it creates both roles with no password (SCRAM refuses a role without a
 * verifier, so neither can sign in over the network), and each environment
 * supplies its own:
 *   - production / preview: `\password` on the server (docs/DEPLOYMENT.md §2);
 *   - CI: a random pair per run, masked, through GITHUB_ENV;
 *   - local development: docker/postgres/dev/02-dev-role-passwords.sql, which
 *     only docker-compose.yml, scripts/dev-db.sh and RUN-LOCALLY.md §10 load.
 *
 * Each rule below is one way of quietly undoing that. The database side — the
 * roles really have no password and no administrative attribute — is proved
 * on every CI run by src/db/security/roles-init.test.sql; this file guards the
 * files that decide what a new cluster receives. Read as text, like the other
 * stack guards, and every rule is re-broken in memory below, in LF and CRLF.
 */

const root = process.cwd();
const lf = (text: string) => text.replace(/\r\n?/g, '\n');
const read = (path: string) => lf(readFileSync(join(root, path), 'utf8'));

const INIT_DIR = 'docker/postgres/init';
const DEV_FILE = 'docker/postgres/dev/02-dev-role-passwords.sql';

type Files = {
  readonly init: Readonly<Record<string, string>>;
  readonly dev: string;
  readonly devCompose: string;
  readonly prodCompose: string;
  readonly previewCompose: string;
  readonly ci: string;
  readonly devDb: string;
  readonly runLocally: string;
  readonly envExample: string;
};

const FILES: Files = {
  init: Object.fromEntries(
    readdirSync(join(root, INIT_DIR)).sort().map((name) => [name, read(`${INIT_DIR}/${name}`)]),
  ),
  dev: read(DEV_FILE),
  devCompose: read('docker-compose.yml'),
  prodCompose: read('docker-compose.prod.yml'),
  previewCompose: read('docker-compose.preview.yml'),
  ci: read('.github/workflows/ci.yml'),
  devDb: read('scripts/dev-db.sh'),
  runLocally: read('docs/RUN-LOCALLY.md'),
  envExample: read('.env.example'),
};

const crlf = (text: string) => lf(text).replace(/\n/g, '\r\n');
const asCrlf = (f: Files): Files => ({
  init: Object.fromEntries(Object.entries(f.init).map(([k, v]) => [k, crlf(v)])),
  dev: crlf(f.dev),
  devCompose: crlf(f.devCompose),
  prodCompose: crlf(f.prodCompose),
  previewCompose: crlf(f.previewCompose),
  ci: crlf(f.ci),
  devDb: crlf(f.devDb),
  runLocally: crlf(f.runLocally),
  envExample: crlf(f.envExample),
});

/** SQL with `--` comments removed, so prose may name what code may not do. */
const sqlCode = (text: string) =>
  lf(text).split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');

/** YAML without `#` comments. */
const yamlCode = (text: string) =>
  lf(text).split('\n').filter((l) => !l.trim().startsWith('#')).map((l) => l.replace(/\s+#.*$/, '')).join('\n');

/** The attribute list of one `CREATE ROLE <name> ...;` statement, upper-cased. */
function roleAttributes(sql: string, role: string): string[] | null {
  const m = new RegExp(`CREATE\\s+ROLE\\s+${role}\\b([^;]*);`, 'i').exec(sqlCode(sql));
  return m ? (m[1] ?? '').toUpperCase().split(/\s+/).filter(Boolean) : null;
}

/** The password each role gets in a file of `ALTER ROLE <role> WITH PASSWORD '<v>';` lines. */
function devPasswords(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sqlCode(sql).matchAll(/ALTER\s+ROLE\s+(\w+)\s+WITH\s+PASSWORD\s+'([^']*)'\s*;/gi)) {
    out.set(m[1] ?? '', m[2] ?? '');
  }
  return out;
}

const REQUIRED = ['LOGIN', 'NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE', 'NOREPLICATION', 'NOBYPASSRLS'];
const FORBIDDEN = ['SUPERUSER', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'BYPASSRLS', 'PASSWORD'];

/** Every rule. Empty means no new cluster is born with a published password. */
function violations(input: Files): string[] {
  const f = Object.fromEntries(
    Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? lf(v) : Object.fromEntries(Object.entries(v).map(([n, t]) => [n, lf(t)]))]),
  ) as Files;
  const found: string[] = [];

  // --- 1. The shared init sets no password, anywhere ---------------------------
  for (const [name, text] of Object.entries(f.init)) {
    if (/\bPASSWORD\b/i.test(sqlCode(text))) found.push(`init-password:${name}`);
  }
  const roles = f.init['01-roles.sql'] ?? '';
  for (const role of ['migrator', 'app_user']) {
    const attrs = roleAttributes(roles, role);
    if (!attrs) { found.push(`role-missing:${role}`); continue; }
    for (const a of REQUIRED) if (!attrs.includes(a)) found.push(`role-attr-missing:${role}:${a}`);
    for (const a of FORBIDDEN) if (attrs.includes(a)) found.push(`role-attr-forbidden:${role}:${a}`);
  }

  // --- 2. The development passwords stay development-only ----------------------
  const pw = devPasswords(f.dev);
  if ([...pw.keys()].sort().join(',') !== 'app_user,migrator') found.push('dev-file-roles');
  const env = f.envExample;
  if (!(pw.get('app_user') && env.includes(`postgresql://app_user:${pw.get('app_user')}@localhost:`))
    || !(pw.get('migrator') && env.includes(`postgresql://migrator:${pw.get('migrator')}@localhost:`))) {
    found.push('dev-file-matches-env-example');
  }
  for (const [key, text] of [['prod', f.prodCompose], ['preview', f.previewCompose]] as const) {
    if (/docker\/postgres\/dev\b|02-dev-role-passwords/.test(yamlCode(text))) found.push(`dev-file-in-${key}`);
  }
  for (const value of pw.values()) {
    if (value && (yamlCode(f.prodCompose).includes(value) || yamlCode(f.previewCompose).includes(value))) {
      found.push('dev-password-in-prod-or-preview');
    }
  }
  const devCompose = yamlCode(f.devCompose);
  if (!devCompose.includes('./docker/postgres/init/01-roles.sql:/docker-entrypoint-initdb.d/01-roles.sql:ro')
    || !devCompose.includes(`./${DEV_FILE}:/docker-entrypoint-initdb.d/02-dev-role-passwords.sql:ro`)) {
    found.push('dev-compose-mounts');
  }
  if (!/-f docker\/postgres\/init\/01-roles\.sql/.test(f.devDb) || !f.devDb.includes(`-f ${DEV_FILE}`)) found.push('dev-db-script');
  if (!f.runLocally.includes('\\docker\\postgres\\dev\\02-dev-role-passwords.sql:/docker-entrypoint-initdb.d/02-dev-role-passwords.sql:ro')) {
    found.push('run-locally-itest-mounts');
  }

  // --- 3. CI brings its own random pair ---------------------------------------
  const ci = yamlCode(f.ci);
  for (const m of ci.matchAll(/postgresql:\/\/(app_user|migrator):([^@\s]*)@/g)) {
    if (!/^\$\{\w+\}$/.test(m[2] ?? '')) found.push(`ci-static-role-password:${m[1]}`);
  }
  if (!ci.includes('-f src/db/security/roles-init.test.sql')) found.push('ci-roles-init-check');
  if (!/::add-mask::\$MIGRATOR_PW/.test(ci) || !/::add-mask::\$APP_PW/.test(ci)) found.push('ci-mask');
  if (!/openssl rand -hex \d+\)"\s*\n\s*APP_PW="\$\(openssl rand -hex/.test(ci)) found.push('ci-random');
  if (!/>> "\$GITHUB_ENV"/.test(ci)) found.push('ci-github-env');

  return found;
}

describe('docker/postgres/init gives no new database a usable password', () => {
  it('the files in the repository satisfy every rule', () => {
    expect(violations(FILES)).toEqual([]);
  });

  it('a Windows checkout (CRLF) satisfies them the same way', () => {
    expect(violations(asCrlf(FILES))).toEqual([]);
  });

  it('the reader sees what it checks', () => {
    // Without these the rules could pass vacuously on a file they cannot parse.
    expect(Object.keys(FILES.init)).toEqual(['01-roles.sql']);
    expect(roleAttributes(FILES.init['01-roles.sql']!, 'app_user')).toEqual(expect.arrayContaining(REQUIRED));
    expect(roleAttributes(FILES.init['01-roles.sql']!, 'migrator')).toEqual(expect.arrayContaining(REQUIRED));
    expect([...devPasswords(FILES.dev).keys()].sort()).toEqual(['app_user', 'migrator']);
  });
});

describe('each guard fails when its defect is re-introduced', () => {
  type Mutation = { readonly defect: string; readonly apply: (f: Files) => Files; readonly rule: string };
  const roles = (f: Files, from: RegExp, to: string): Files => ({
    ...f, init: { ...f.init, '01-roles.sql': (f.init['01-roles.sql'] ?? '').replace(from, to) },
  });

  const mutations: readonly Mutation[] = [
    {
      defect: 'a password back in CREATE ROLE',
      apply: (f) => roles(f, /CREATE ROLE app_user WITH LOGIN/, "CREATE ROLE app_user WITH LOGIN PASSWORD 'x'"),
      rule: 'init-password:01-roles.sql',
    },
    {
      defect: 'a password set later in the shared init',
      apply: (f) => roles(f, /\n\\connect/, "\nALTER ROLE migrator WITH PASSWORD 'x';\n\\connect"),
      rule: 'init-password:01-roles.sql',
    },
    {
      defect: 'the dev file moved into the shared init directory',
      apply: (f) => ({ ...f, init: { ...f.init, '02-dev-role-passwords.sql': f.dev } }),
      rule: 'init-password:02-dev-role-passwords.sql',
    },
    {
      defect: 'app_user made a superuser',
      apply: (f) => roles(f, /(CREATE ROLE app_user WITH LOGIN) NOSUPERUSER/, '$1 SUPERUSER'),
      rule: 'role-attr-forbidden:app_user:SUPERUSER',
    },
    {
      defect: 'app_user given BYPASSRLS',
      apply: (f) => roles(f, /(CREATE ROLE app_user WITH LOGIN.*) NOBYPASSRLS;/, '$1 BYPASSRLS;'),
      rule: 'role-attr-forbidden:app_user:BYPASSRLS',
    },
    {
      defect: 'migrator allowed to create roles',
      apply: (f) => roles(f, /(CREATE ROLE migrator WITH LOGIN NOSUPERUSER NOCREATEDB) NOCREATEROLE/, '$1 CREATEROLE'),
      rule: 'role-attr-forbidden:migrator:CREATEROLE',
    },
    {
      defect: 'the production stack mounting the dev passwords',
      apply: (f) => ({ ...f, prodCompose: f.prodCompose.replace('      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro\n', '      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro\n      - ./docker/postgres/dev:/docker-entrypoint-initdb.d/dev:ro\n') }),
      rule: 'dev-file-in-prod',
    },
    {
      defect: 'the dev compose dropping the dev passwords',
      apply: (f) => ({ ...f, devCompose: f.devCompose.replace(/\n\s+- \.\/docker\/postgres\/dev\/02-dev-role-passwords\.sql:[^\n]*/, '') }),
      rule: 'dev-compose-mounts',
    },
    {
      defect: 'the dev passwords drifting from .env.example',
      apply: (f) => ({ ...f, dev: f.dev.replace(/(ALTER ROLE app_user WITH PASSWORD ')[^']*'/, "$1drifted'") }),
      rule: 'dev-file-matches-env-example',
    },
    {
      defect: 'a static role password back in CI',
      apply: (f) => ({ ...f, ci: f.ci.replace('        run: npm run db:migrate\n', '        env:\n          DATABASE_MIGRATION_URL: postgresql://migrator:literal@localhost:5432/engineering_marketplace\n        run: npm run db:migrate\n') }),
      rule: 'ci-static-role-password:migrator',
    },
    {
      defect: 'CI no longer masking the per-run password',
      apply: (f) => ({ ...f, ci: f.ci.replace('echo "::add-mask::$APP_PW"\n', '') }),
      rule: 'ci-mask',
    },
    {
      defect: 'CI skipping the init roles check',
      apply: (f) => ({ ...f, ci: f.ci.replace('-f src/db/security/roles-init.test.sql', '-f /dev/null') }),
      rule: 'ci-roles-init-check',
    },
    {
      defect: 'the integration-test container of RUN-LOCALLY.md losing the dev passwords',
      apply: (f) => ({ ...f, runLocally: f.runLocally.replace(/\n[^\n]*02-dev-role-passwords\.sql:\/docker-entrypoint-initdb\.d[^\n]*/, '') }),
      rule: 'run-locally-itest-mounts',
    },
  ];

  it.each(mutations)('$defect → $rule', ({ apply, rule }) => {
    const mutated = apply(FILES);
    expect(mutated, 'the mutation did not apply').not.toEqual(FILES);
    expect(violations(mutated)).toContain(rule);
    expect(violations(asCrlf(mutated))).toContain(rule);
  });
});
