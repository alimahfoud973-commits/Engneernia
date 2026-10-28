import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE LAPTOP TRIAL SITS NEXT TO TWO PROJECTS IT MUST NEVER TOUCH.
 *
 * docker-compose.trial.yml runs the production stack on the owner's laptop,
 * where `enginora-live` (development) and `enginora-preview` already live,
 * the preview's PostgreSQL holds 127.0.0.1:5432, and the checkout folder is
 * named `Enginora-live` — so a Compose command that loses the project name
 * lands on the development database volume. Each rule below turns one way of
 * reaching those projects, or of quietly weakening the trial, into a failing
 * build:
 *
 *   - the project name dropped, and the volume and network names no longer
 *     pinned to `enginora-trial_*`;
 *   - a published port other than the app on 127.0.0.1:3100, or production's
 *     ports kept because a list was appended instead of replaced;
 *   - a service that restarts by itself, including one production adds later
 *     and the overlay forgets to cover;
 *   - the scanner made optional, replaced, pointed elsewhere, or run with a
 *     clamd.conf more lenient than production's;
 *   - a tunnel, Caddy, real storage, real mail, or indexing;
 *   - a runbook command that does not name the project.
 *
 * Like preview-stack.test.ts it reads the files as text: the repository has no
 * YAML parser as a direct dependency, the overlay is kept in a plain block
 * style a line reader understands, and what it cannot follow (anchors, merges,
 * includes, flow mappings, YAML tags other than the four it expects) is
 * refused outright. What a text reader cannot prove — how Compose itself
 * merges the two files — is checked on the laptop by the preflight in
 * docs/TRIAL-PREVIEW.md, from `config --format json`.
 *
 * The negative cases at the bottom re-introduce each defect into an in-memory
 * copy and require the matching rule to fire.
 */

const root = process.cwd();

/** Every line break as LF; see preview-stack.test.ts for why. */
const lf = (text: string) => text.replace(/\r\n?/g, '\n');
const read = (path: string) => lf(readFileSync(join(root, path), 'utf8'));

const FILES = {
  compose: read('docker-compose.trial.yml'),
  clamd: read('deploy/clamav/clamd.trial.conf'),
  prodClamd: read('deploy/clamav/clamd.conf'),
  prod: read('docker-compose.prod.yml'),
  docs: read('docs/TRIAL-PREVIEW.md'),
};
type Files = typeof FILES;

const asCrlf = (files: Files): Files =>
  Object.fromEntries(
    Object.entries(files).map(([key, text]) => [key, lf(text).replace(/\n/g, '\r\n')]),
  ) as Files;

/** Every service the overlay may define, and the only keys each may set. */
const ALLOWED_SERVICE_KEYS: Readonly<Record<string, readonly string[]>> = {
  postgres: ['restart', 'ports'],
  clamav: ['restart', 'volumes', 'environment', 'mem_limit'],
  app: ['restart', 'ports', 'depends_on', 'environment'],
  storage: ['image', 'restart', 'environment', 'volumes', 'healthcheck'],
  'storage-init': ['image', 'restart', 'depends_on', 'environment', 'entrypoint'],
  tools: ['build', 'profiles', 'restart', 'depends_on', 'environment'],
};

/** The only YAML tags the overlay may use, and where. */
const EXPECTED_TAGS = [
  'postgres.ports !reset []',
  'clamav.volumes !override',
  'app.ports !override',
  'app.depends_on !override',
];

/** The app values fixed by the overlay, whatever .env.trial.local says. */
const APP_ENVIRONMENT: Readonly<Record<string, string>> = {
  APP_URL: 'http://127.0.0.1:3100',
  STORAGE_ENDPOINT: 'http://storage:9000',
  STORAGE_REGION: 'us-east-1',
  MAIL_TRANSPORT_URL: 'smtp://mail.invalid:25',
  MAIL_FROM: 'noreply@enginora.invalid',
  SEO_INDEXABLE: 'false',
};

/** The Docker VM on the owner's laptop is 3.77 GiB; clamd must leave room. */
const CLAMAV_MEM_CEILING_BYTES = 3 * 1024 ** 3;

const ENGINE_ID = '32848270-4c74-4c6b-a632-88f550343be9';
const COMPOSE_LINE =
  'docker compose -p enginora-trial -f docker-compose.prod.yml -f docker-compose.trial.yml --env-file .env.trial.local';

/** The text with `#` comments removed, so prose can name what code may not. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');
}

/** Top-level key → its lines, for a block-style mapping such as `services:`. */
function section(yaml: string, name: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let inside = false;
  let current: string[] | null = null;
  for (const line of code(yaml).split('\n')) {
    if (/^\S/.test(line)) {
      inside = new RegExp(`^${name}:\\s*$`).test(line);
      current = null;
      continue;
    }
    if (!inside) continue;
    const start = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (start?.[1]) {
      current = [];
      blocks.set(start[1], current);
    } else if (current && line.trim() !== '') {
      current.push(line);
    }
  }
  return blocks;
}

const services = (yaml: string) => section(yaml, 'services');

/** The keys a service block sets directly. */
function keysOf(block: readonly string[]): string[] {
  return block.flatMap((line) => {
    const key = /^ {4}([A-Za-z_]+):/.exec(line)?.[1];
    return key ? [key] : [];
  });
}

/** The key's own line, and the deeper lines under it. */
function entry(block: readonly string[], key: string): { head: string; body: string[] } | null {
  const at = block.findIndex((line) => new RegExp(`^ {4}${key}:`).test(line));
  if (at < 0) return null;
  const body: string[] = [];
  for (const line of block.slice(at + 1)) {
    if (!/^ {6}/.test(line)) break;
    body.push(line.trim());
  }
  return { head: (block[at] ?? '').trim(), body };
}

/** A `KEY: value` mapping under a service key, quotes removed. */
function mapping(block: readonly string[], key: string): Record<string, string> {
  const found = entry(block, key);
  if (!found) return {};
  return Object.fromEntries(
    found.body.flatMap((line) => {
      const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
      return match?.[1] ? [[match[1], (match[2] ?? '').replace(/^'(.*)'$/, '$1')]] : [];
    }),
  );
}

/** clamd directives, comments and blank lines removed. */
const directives = (conf: string) =>
  lf(conf)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

/** Compose's byte suffixes, for `mem_limit`. */
function bytes(value: string): number {
  const match = /^(\d+)([bkmg])?$/i.exec(value.trim());
  if (!match?.[1]) return Number.NaN;
  const unit = (match[2] ?? 'b').toLowerCase();
  return Number(match[1]) * 1024 ** 'bkmg'.indexOf(unit);
}

/** The fenced code blocks of a Markdown file. */
const fenced = (markdown: string) =>
  [...lf(markdown).matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? '');

/** Every rule the files must satisfy. Empty means the trial is isolated. */
function violations(input: Files): string[] {
  const files = Object.fromEntries(
    Object.entries(input).map(([key, text]) => [key, lf(text)]),
  ) as Files;
  const found: string[] = [];
  const fail = (rule: string) => found.push(rule);
  const compose = code(files.compose);
  const blocks = services(files.compose);
  const block = (name: string) => blocks.get(name) ?? [];

  // --- The overlay as a whole -------------------------------------------------
  if (!/^name:\s*enginora-trial\s*$/m.test(compose)) fail('project-name');
  if (/\b(MALWARE_SCANNER|CLAMAV_HOST|CLAMAV_PORT|NODE_ENV)\b/.test(compose)) fail('scanner-env');
  if (/(^|\s)[&*][A-Za-z]|<<\s*:|^\s*(extends|include)\s*:|(^|[^$])\{/m.test(compose)) {
    fail('plain-yaml');
  }
  const tags: string[] = [];
  for (const [name, lines] of blocks) {
    for (const line of lines) {
      const tagged = /^ {4}([A-Za-z_]+):\s*(!\S+.*)$/.exec(line);
      if (tagged) tags.push(`${name}.${tagged[1]} ${tagged[2]?.trim()}`);
    }
  }
  const strayTag = compose
    .split('\n')
    .some((line) => /:\s*!/.test(line) && !/^ {4}[A-Za-z_]+:\s*!/.test(line));
  if (strayTag || JSON.stringify(tags.sort()) !== JSON.stringify([...EXPECTED_TAGS].sort())) {
    fail('yaml-tags');
  }
  if (
    /\b(network_mode|privileged|aliases|hostname|extra_hosts|container_name|cap_add|devices)\s*:/.test(compose)
    || /^ {4}networks\s*:/m.test(compose)
  ) {
    fail('no-network-tricks');
  }
  if (/minioadmin/i.test(compose)) fail('no-default-credentials');
  if (/cloudflared|trycloudflare|tunnel|caddy/i.test(compose)) fail('no-tunnel');

  for (const [name, lines] of blocks) {
    const allowed = ALLOWED_SERVICE_KEYS[name];
    if (!allowed) {
      fail(`unknown-service:${name}`);
      continue;
    }
    for (const key of keysOf(lines)) {
      if (!allowed.includes(key)) fail(`key:${name}.${key}`);
    }
    if (!lines.some((line) => /^ {4}restart:\s*'no'\s*$/.test(line))) fail(`restart:${name}`);
  }

  // Every production service is covered, or it would run with production's
  // restart policy and ports, unseen by every rule here.
  for (const name of services(files.prod).keys()) {
    if (!blocks.has(name)) fail(`prod-service-uncovered:${name}`);
  }

  // --- Ports: one, on loopback, replacing production's ----------------------
  const pgPorts = entry(block('postgres'), 'ports');
  if (pgPorts?.head !== 'ports: !reset []' || pgPorts.body.length !== 0) fail('postgres-ports-reset');
  const appPorts = entry(block('app'), 'ports');
  if (
    appPorts?.head !== 'ports: !override'
    || JSON.stringify(appPorts.body) !== JSON.stringify(["- '127.0.0.1:3100:3000'"])
  ) {
    fail('app-port');
  }
  for (const [name, lines] of blocks) {
    if (name !== 'postgres' && name !== 'app' && entry(lines, 'ports')) fail('no-other-ports');
  }

  // --- The app: local values fixed, scanner awaited --------------------------
  if (JSON.stringify(mapping(block('app'), 'environment')) !== JSON.stringify(APP_ENVIRONMENT)) {
    fail('app-env');
  }
  const appDeps = entry(block('app'), 'depends_on');
  const dependsOn = (appDeps?.body ?? []).join('\n');
  if (
    appDeps?.head !== 'depends_on: !override'
    || !/clamav:\n\s*condition: service_healthy/.test(dependsOn)
    || !/postgres:\n\s*condition: service_healthy/.test(dependsOn)
  ) {
    fail('app-depends-on');
  }

  // --- ClamAV: runs, unreplaced, production's limits, no update daemon ------
  const clamavEnv = mapping(block('clamav'), 'environment');
  if (JSON.stringify(clamavEnv) !== JSON.stringify({ CLAMAV_NO_FRESHCLAMD: 'true' })) fail('clamav-env');
  const clamavVolumes = entry(block('clamav'), 'volumes');
  if (
    clamavVolumes?.head !== 'volumes: !override'
    || JSON.stringify(clamavVolumes.body) !== JSON.stringify([
      '- clamav_db:/var/lib/clamav',
      '- ./deploy/clamav/clamd.trial.conf:/etc/clamav/clamd.conf:ro',
    ])
  ) {
    fail('clamav-config');
  }
  const memLimit = /^mem_limit:\s*(\S+)$/.exec(entry(block('clamav'), 'mem_limit')?.head ?? '')?.[1];
  if (!memLimit || !(bytes(memLimit) <= CLAMAV_MEM_CEILING_BYTES)) fail('clamav-mem');

  const trialDirectives = directives(files.clamd);
  if (!trialDirectives.includes('ConcurrentDatabaseReload no')) fail('clamd-no-concurrent-reload');
  const shared = trialDirectives.filter((line) => line !== 'ConcurrentDatabaseReload no');
  if (JSON.stringify(shared) !== JSON.stringify(directives(files.prodClamd))) fail('clamd-same-as-prod');

  // --- tools: opt-in, migrator only, no bind mount ---------------------------
  const tools = block('tools');
  if (!tools.some((line) => /^ {4}profiles:\s*\[\s*'tools'\s*\]\s*$/.test(line))) fail('tools-opt-in');
  if (!entry(tools, 'build')?.body.includes('target: build')) fail('tools-target');
  const toolsEnv = Object.keys(mapping(tools, 'environment'));
  if (JSON.stringify(toolsEnv) !== JSON.stringify(['DATABASE_MIGRATION_URL'])) fail('tools-env');

  // --- Volumes and networks pinned to the trial ------------------------------
  const prodVolumes = [...section(files.prod, 'volumes').keys()];
  const volumes = section(files.compose, 'volumes');
  for (const name of new Set([...prodVolumes, 'storage_data'])) {
    const lines = volumes.get(name) ?? [];
    if (JSON.stringify(lines.map((line) => line.trim())) !== JSON.stringify([`name: enginora-trial_${name}`])) {
      fail(`volume-name:${name}`);
    }
  }
  const networks = section(files.compose, 'networks');
  for (const name of new Set([...section(files.prod, 'networks').keys(), 'default'])) {
    const lines = networks.get(name) ?? [];
    if (JSON.stringify(lines.map((line) => line.trim())) !== JSON.stringify([`name: enginora-trial_${name}`])) {
      fail(`network-name:${name}`);
    }
  }

  // --- The production file the overlay leans on ------------------------------
  const prod = code(files.prod);
  if (!/^\s+MALWARE_SCANNER:\s*clamav\s*$/m.test(prod)) fail('prod-scanner');
  if (!/^\s+NODE_ENV:\s*production\s*$/m.test(prod)) fail('prod-node-env');

  // --- The runbook: every Compose command names the project -----------------
  const commands = fenced(files.docs).join('\n');
  // `docker compose ls` lists projects and takes none; a file name such as
  // docker-compose.trial.yml is not a command.
  for (const line of commands.split('\n')) {
    const invokes = /docker[ -]compose(?![.\w])/.test(line.replace(/docker compose ls\b/g, ''));
    if (invokes && !line.includes(COMPOSE_LINE)) fail('docs-project-flag');
  }
  if ((commands.match(/docker compose/g) ?? []).length === 0) fail('docs-project-flag');
  if (!commands.includes(ENGINE_ID) || !/\$env:COMPOSE_PROJECT_NAME/.test(commands)) fail('docs-preflight');
  // clamd rejects a value ending in CR, which is what a Windows checkout gives it.
  if (!/clamd\.trial\.conf'\)\)\.Contains\("`r"\)/.test(commands)) fail('docs-preflight-crlf');
  if (
    /\b(down|prune|kill)\b|docker (container |volume |network |image )?rm\b|\brmi\b/.test(commands)
  ) {
    fail('docs-destructive');
  }
  if (/seed:(demo|scale)|cloudflared|--profile tunnel|\.env\.local\b|\.env\.preview\.local/.test(commands)) {
    fail('docs-forbidden');
  }
  for (const line of commands.split('\n')) {
    if (/\bconfig\b/.test(line) && /trial\s+(\S+\s+)*config\b/.test(line)
      && !/config --quiet|config --format json/.test(line)) {
      fail('docs-config-prints-secrets');
    }
  }

  return [...new Set(found)];
}

describe('docker-compose.trial.yml stays out of the projects beside it', () => {
  it('the files in the repository satisfy every rule', () => {
    expect(violations(FILES)).toEqual([]);
  });

  it('a Windows checkout (CRLF) satisfies them the same way', () => {
    expect(violations(asCrlf(FILES))).toEqual([]);
  });

  it('the line reader sees the services, volumes and networks the overlay defines', () => {
    // If the layout drifted out of what `section()` understands, every rule
    // per block would pass vacuously. Pin what it must find.
    expect([...services(FILES.compose).keys()].sort()).toEqual(Object.keys(ALLOWED_SERVICE_KEYS).sort());
    expect([...section(FILES.compose, 'volumes').keys()].sort()).toEqual(
      ['clamav_db', 'postgres_data', 'storage_data'],
    );
    expect([...section(FILES.compose, 'networks').keys()].sort()).toEqual(['default', 'scanner']);
    expect([...services(FILES.prod).keys()].sort()).toEqual(['app', 'clamav', 'postgres']);
    expect(fenced(FILES.docs).length).toBeGreaterThan(0);
  });
});

describe('each guard fails when its defect is re-introduced', () => {
  type Mutation = {
    readonly defect: string;
    readonly file: keyof Files;
    readonly from: string | RegExp;
    readonly to: string;
    readonly rule: string;
  };

  const mutations: readonly Mutation[] = [
    // project and data
    { defect: 'the project name dropped', file: 'compose', from: 'name: enginora-trial\n', to: '', rule: 'project-name' },
    {
      defect: 'the project renamed to the development one',
      file: 'compose',
      from: 'name: enginora-trial\n',
      to: 'name: enginora-live\n',
      rule: 'project-name',
    },
    {
      defect: 'the database volume left to the project name',
      file: 'compose',
      from: '    name: enginora-trial_postgres_data\n',
      to: '',
      rule: 'volume-name:postgres_data',
    },
    {
      defect: 'the database volume pinned to the development volume',
      file: 'compose',
      from: 'name: enginora-trial_postgres_data',
      to: 'name: enginora-live_postgres_data',
      rule: 'volume-name:postgres_data',
    },
    {
      defect: 'the storage volume pinned to the preview',
      file: 'compose',
      from: 'name: enginora-trial_storage_data',
      to: 'name: enginora-preview_storage_data',
      rule: 'volume-name:storage_data',
    },
    {
      defect: 'the default network joined to the preview',
      file: 'compose',
      from: 'name: enginora-trial_default',
      to: 'name: enginora-preview_default',
      rule: 'network-name:default',
    },
    {
      defect: 'a volume production adds, not pinned here',
      file: 'prod',
      from: 'volumes:\n  postgres_data:\n',
      to: 'volumes:\n  postgres_data:\n  extra_data:\n',
      rule: 'volume-name:extra_data',
    },
    // ports
    {
      defect: 'production postgres port kept (reset removed)',
      file: 'compose',
      from: '    ports: !reset []\n',
      to: '',
      rule: 'postgres-ports-reset',
    },
    {
      defect: 'postgres published on another port',
      file: 'compose',
      from: '    ports: !reset []\n',
      to: "    ports: !reset\n      - '127.0.0.1:55432:5432'\n",
      rule: 'postgres-ports-reset',
    },
    {
      defect: 'app list appended to production (no !override)',
      file: 'compose',
      from: '    ports: !override\n',
      to: '    ports:\n',
      rule: 'app-port',
    },
    {
      defect: 'app on every interface',
      file: 'compose',
      from: "'127.0.0.1:3100:3000'",
      to: "'3100:3000'",
      rule: 'app-port',
    },
    {
      defect: 'app on 0.0.0.0',
      file: 'compose',
      from: "'127.0.0.1:3100:3000'",
      to: "'0.0.0.0:3100:3000'",
      rule: 'app-port',
    },
    {
      defect: 'a second app port',
      file: 'compose',
      from: "      - '127.0.0.1:3100:3000'\n",
      to: "      - '127.0.0.1:3100:3000'\n      - '127.0.0.1:3000:3000'\n",
      rule: 'app-port',
    },
    {
      defect: 'RustFS published',
      file: 'compose',
      from: '    image: rustfs/rustfs:1.0.0\n',
      to: "    image: rustfs/rustfs:1.0.0\n    ports:\n      - '127.0.0.1:9000:9000'\n",
      rule: 'no-other-ports',
    },
    {
      defect: 'clamd published',
      file: 'compose',
      from: '    mem_limit: 2g\n',
      to: "    mem_limit: 2g\n    ports:\n      - '127.0.0.1:3310:3310'\n",
      rule: 'no-other-ports',
    },
    // restart
    {
      defect: 'postgres restarting by itself',
      file: 'compose',
      from: "  postgres:\n    restart: 'no'\n",
      to: '  postgres:\n    restart: unless-stopped\n',
      rule: 'restart:postgres',
    },
    {
      defect: 'the app inheriting production restart',
      file: 'compose',
      from: "  app:\n    restart: 'no'\n",
      to: '  app:\n',
      rule: 'restart:app',
    },
    {
      defect: 'clamav inheriting production restart',
      file: 'compose',
      from: "  clamav:\n    restart: 'no'\n",
      to: '  clamav:\n',
      rule: 'restart:clamav',
    },
    {
      defect: 'storage restarting always',
      file: 'compose',
      from: "    image: rustfs/rustfs:1.0.0\n    restart: 'no'\n",
      to: '    image: rustfs/rustfs:1.0.0\n    restart: always\n',
      rule: 'restart:storage',
    },
    {
      defect: 'a service production adds, not covered here',
      file: 'prod',
      from: 'volumes:\n  postgres_data:\n',
      to: '  worker:\n    image: example/worker\n    restart: unless-stopped\n\nvolumes:\n  postgres_data:\n',
      rule: 'prod-service-uncovered:worker',
    },
    // tunnel and extra services
    {
      defect: 'a tunnel service added',
      file: 'compose',
      from: '  tools:\n',
      to: "  cloudflared:\n    image: cloudflare/cloudflared:2026.9.1\n    restart: 'no'\n  tools:\n",
      rule: 'unknown-service:cloudflared',
    },
    {
      defect: 'Caddy added',
      file: 'compose',
      from: '  tools:\n',
      to: "  caddy:\n    image: caddy:2.10.2\n    restart: 'no'\n  tools:\n",
      rule: 'no-tunnel',
    },
    // scanner
    {
      defect: 'MALWARE_SCANNER=none given to the app',
      file: 'compose',
      from: "      SEO_INDEXABLE: 'false'\n",
      to: "      SEO_INDEXABLE: 'false'\n      MALWARE_SCANNER: none\n",
      rule: 'scanner-env',
    },
    {
      defect: 'the app pointed at another scanner host',
      file: 'compose',
      from: "      SEO_INDEXABLE: 'false'\n",
      to: "      SEO_INDEXABLE: 'false'\n      CLAMAV_HOST: stub\n",
      rule: 'scanner-env',
    },
    {
      defect: 'clamav replaced by a stub image',
      file: 'compose',
      from: "  clamav:\n    restart: 'no'\n",
      to: "  clamav:\n    restart: 'no'\n    image: example/always-ok\n",
      rule: 'key:clamav.image',
    },
    {
      defect: 'clamav not started',
      file: 'compose',
      from: "  clamav:\n    restart: 'no'\n",
      to: "  clamav:\n    restart: 'no'\n    profiles: ['clamav']\n",
      rule: 'key:clamav.profiles',
    },
    {
      defect: 'the app no longer waiting for clamd',
      file: 'compose',
      from: '      clamav:\n        condition: service_healthy\n',
      to: '',
      rule: 'app-depends-on',
    },
    {
      defect: 'clamav mounting the production clamd.conf',
      file: 'compose',
      from: './deploy/clamav/clamd.trial.conf:/etc/clamav/clamd.conf:ro',
      to: './deploy/clamav/clamd.conf:/etc/clamav/clamd.conf:ro',
      rule: 'clamav-config',
    },
    {
      defect: 'clamav volumes appended to production (no !override)',
      file: 'compose',
      from: '    volumes: !override\n',
      to: '    volumes:\n',
      rule: 'clamav-config',
    },
    {
      defect: 'the update daemon left on',
      file: 'compose',
      from: "CLAMAV_NO_FRESHCLAMD: 'true'",
      to: "CLAMAV_NO_FRESHCLAMD: 'false'",
      rule: 'clamav-env',
    },
    {
      defect: 'clamd allowed the whole VM',
      file: 'compose',
      from: '    mem_limit: 2g\n',
      to: '    mem_limit: 4g\n',
      rule: 'clamav-mem',
    },
    {
      defect: 'clamd with no memory limit',
      file: 'compose',
      from: '    mem_limit: 2g\n',
      to: '',
      rule: 'clamav-mem',
    },
    {
      defect: 'trial clamd answering OK above the limits',
      file: 'clamd',
      from: 'AlertExceedsMax yes',
      to: 'AlertExceedsMax no',
      rule: 'clamd-same-as-prod',
    },
    {
      defect: 'trial clamd with a smaller stream limit',
      file: 'clamd',
      from: 'StreamMaxLength 1025M',
      to: 'StreamMaxLength 10M',
      rule: 'clamd-same-as-prod',
    },
    {
      defect: 'trial clamd with an extra lenient directive',
      file: 'clamd',
      from: 'ConcurrentDatabaseReload no',
      to: 'ConcurrentDatabaseReload no\nDetectPUA no',
      rule: 'clamd-same-as-prod',
    },
    {
      defect: 'trial clamd holding two signature sets on reload',
      file: 'clamd',
      from: 'ConcurrentDatabaseReload no',
      to: 'ConcurrentDatabaseReload yes',
      rule: 'clamd-no-concurrent-reload',
    },
    {
      defect: 'production clamd changed without the trial',
      file: 'prodClamd',
      from: 'MaxScanTime 120000',
      to: 'MaxScanTime 300000',
      rule: 'clamd-same-as-prod',
    },
    // app values
    {
      defect: 'indexing turned on',
      file: 'compose',
      from: "SEO_INDEXABLE: 'false'",
      to: "SEO_INDEXABLE: 'true'",
      rule: 'app-env',
    },
    {
      defect: 'storage left to the env file (could be R2)',
      file: 'compose',
      from: "      STORAGE_ENDPOINT: 'http://storage:9000'\n",
      to: '',
      rule: 'app-env',
    },
    {
      defect: 'a real mail transport',
      file: 'compose',
      from: "'smtp://mail.invalid:25'",
      to: "'smtps://smtp.example.com:465'",
      rule: 'app-env',
    },
    {
      defect: 'the app on the development server',
      file: 'compose',
      from: "  app:\n    restart: 'no'\n",
      to: "  app:\n    restart: 'no'\n    command: ['npm', 'run', 'dev']\n",
      rule: 'key:app.command',
    },
    // tools
    {
      defect: 'tools started with the stack',
      file: 'compose',
      from: "    profiles: ['tools']\n",
      to: '',
      rule: 'tools-opt-in',
    },
    {
      defect: 'tools mounting the checkout (and its .env.local)',
      file: 'compose',
      from: "    profiles: ['tools']\n",
      to: "    profiles: ['tools']\n    volumes:\n      - .:/app\n",
      rule: 'key:tools.volumes',
    },
    {
      defect: 'tools given the app connection',
      file: 'compose',
      from: '      DATABASE_MIGRATION_URL: ${DATABASE_MIGRATION_URL:?set DATABASE_MIGRATION_URL (migrator)}\n',
      to: '      DATABASE_MIGRATION_URL: ${DATABASE_MIGRATION_URL:?set DATABASE_MIGRATION_URL (migrator)}\n'
        + '      DATABASE_URL: ${DATABASE_URL}\n',
      rule: 'tools-env',
    },
    {
      defect: 'tools on the scanner network',
      file: 'compose',
      from: "    profiles: ['tools']\n",
      to: "    profiles: ['tools']\n    networks: [default, scanner]\n",
      rule: 'no-network-tricks',
    },
    // yaml
    {
      defect: 'a YAML anchor smuggling settings in',
      file: 'compose',
      from: '  storage:\n',
      to: '  storage: &shared\n',
      rule: 'plain-yaml',
    },
    {
      defect: 'an unexpected YAML tag',
      file: 'compose',
      from: '    healthcheck:\n',
      to: '    healthcheck: !reset\n',
      rule: 'yaml-tags',
    },
    {
      defect: 'default storage credentials',
      file: 'compose',
      from: /\$\{STORAGE_ACCESS_KEY_ID:\?set STORAGE_ACCESS_KEY_ID\}/,
      to: 'minioadmin',
      rule: 'no-default-credentials',
    },
    // production
    {
      defect: 'production told `none`',
      file: 'prod',
      from: 'MALWARE_SCANNER: clamav',
      to: 'MALWARE_SCANNER: none',
      rule: 'prod-scanner',
    },
    // runbook
    {
      defect: 'a runbook command without the project name',
      file: 'docs',
      from: COMPOSE_LINE,
      to: 'docker compose -f docker-compose.prod.yml -f docker-compose.trial.yml --env-file .env.trial.local',
      rule: 'docs-project-flag',
    },
    {
      defect: 'a runbook command naming the preview project',
      file: 'docs',
      from: COMPOSE_LINE,
      to: COMPOSE_LINE.replace('-p enginora-trial', '-p enginora-preview'),
      rule: 'docs-project-flag',
    },
    {
      defect: 'the preflight no longer checks the engine',
      file: 'docs',
      from: new RegExp(ENGINE_ID, 'g'),
      to: '<engine>',
      rule: 'docs-preflight',
    },
    {
      defect: 'the preflight no longer refuses a CRLF clamd.trial.conf',
      file: 'docs',
      from: '.Contains("`r")',
      to: '.Length',
      rule: 'docs-preflight-crlf',
    },
    {
      defect: 'a teardown that deletes volumes',
      file: 'docs',
      from: /^trial stop\s*$/m,
      to: 'trial down -v',
      rule: 'docs-destructive',
    },
    {
      defect: 'the demo seed in the runbook',
      file: 'docs',
      from: /npm run seed:catalog/,
      to: 'npm run seed:demo',
      rule: 'docs-forbidden',
    },
    {
      defect: 'the preview env file in the runbook',
      file: 'docs',
      from: COMPOSE_LINE,
      to: COMPOSE_LINE.replace('.env.trial.local', '.env.preview.local'),
      rule: 'docs-forbidden',
    },
    {
      defect: 'plain config, which prints every secret',
      file: 'docs',
      from: /^trial config --quiet\s*$/m,
      to: 'trial config',
      rule: 'docs-config-prints-secrets',
    },
  ];

  it.each(mutations)('$defect → $rule', ({ file, from, to, rule }) => {
    const mutated = FILES[file].replace(from, to);
    // A mutation that changes nothing proves nothing.
    expect(mutated, 'the mutation did not apply').not.toBe(FILES[file]);
    expect(violations({ ...FILES, [file]: mutated })).toContain(rule);
    expect(violations(asCrlf({ ...FILES, [file]: mutated }))).toContain(rule);
  });
});
