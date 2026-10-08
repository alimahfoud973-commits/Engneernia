import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE LAPTOP PREVIEW MAY MAKE CLAMAV UNAVAILABLE. IT MAY NOT MAKE IT OPTIONAL.
 *
 * docker-compose.preview.yml exists because ClamAV's signature servers refuse
 * Syrian connections, so clamd cannot run on the owner's laptop. The overlay
 * answers that by not starting the service, and nothing else: the app keeps
 * MALWARE_SCANNER=clamav from the production file, every scan comes back
 * FAILED, and every upload that needs one is refused before storage.
 *
 * That property lives in a YAML file nobody tests, on a machine that is
 * reachable from the internet. Each line below turns a way of quietly losing
 * it into a failing build:
 *
 *   - telling the app `none`, which produces SKIPPED files (or pointing it at
 *     another host, a stub answering OK, an alias named `clamav`);
 *   - publishing a port. Compose APPENDS `ports:` across files, so a single
 *     entry here publishes a service on every interface whatever the
 *     production file says;
 *   - starting the tunnel by default, or aiming it past Caddy;
 *   - running the development server behind the tunnel;
 *   - sharing the development database volume, by dropping the project name;
 *   - Caddy trusting the visitor's X-Forwarded-For.
 *
 * It reads the files as text on purpose. The repository has no YAML parser as
 * a direct dependency, and the overlay is kept in a plain block style that a
 * line reader understands; constructs it cannot follow (anchors, merges,
 * includes, flow mappings) are refused outright rather than half-understood.
 *
 * The negative cases at the bottom re-introduce each defect into an in-memory
 * copy and require the matching rule to fire. A guard is only a guard if it
 * fails, and they prove that on every run instead of once by hand.
 */

const root = process.cwd();

/**
 * Every line break as LF. Git for Windows checks these files out with CRLF
 * (core.autocrlf=true), and both YAML and the Caddyfile read CR, LF and CRLF
 * as the same break, so this is the text Compose and Caddy see on either
 * system. Without it the mutations below, written with `\n`, found nothing to
 * replace on the owner's laptop and failed as "did not apply".
 */
const lf = (text: string) => text.replace(/\r\n?/g, '\n');
const read = (path: string) => lf(readFileSync(join(root, path), 'utf8'));

const FILES = {
  compose: read('docker-compose.preview.yml'),
  caddy: read('deploy/Caddyfile.preview'),
  prod: read('docker-compose.prod.yml'),
};
type Files = typeof FILES;

/** The same files as a Windows checkout writes them to disk. */
const asCrlf = (files: Files): Files => ({
  compose: lf(files.compose).replace(/\n/g, '\r\n'),
  caddy: lf(files.caddy).replace(/\n/g, '\r\n'),
  prod: lf(files.prod).replace(/\n/g, '\r\n'),
});

/** Every service the overlay may define, and the only keys each may set. */
const ALLOWED_SERVICE_KEYS: Readonly<Record<string, readonly string[]>> = {
  clamav: ['profiles'],
  app: ['depends_on'],
  storage: ['image', 'restart', 'environment', 'volumes', 'healthcheck'],
  'storage-init': ['image', 'depends_on', 'environment', 'entrypoint'],
  caddy: ['image', 'restart', 'depends_on', 'volumes'],
  cloudflared: ['image', 'profiles', 'restart', 'depends_on', 'command'],
};

/** The text with `#` comments removed, so prose can name what code may not. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');
}

/** Service name → its lines, for a block-style `services:` mapping. */
function services(yaml: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let inServices = false;
  let current: string[] | null = null;
  for (const line of code(yaml).split('\n')) {
    if (/^\S/.test(line)) {
      inServices = /^services:\s*$/.test(line);
      current = null;
      continue;
    }
    if (!inServices) continue;
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

/** The keys a service block sets directly. */
function keysOf(block: readonly string[]): string[] {
  return block.flatMap((line) => {
    const key = /^ {4}([A-Za-z_]+):/.exec(line)?.[1];
    return key ? [key] : [];
  });
}

/** Every rule the three files must satisfy. Empty means the stack is safe. */
function violations(input: Files): string[] {
  // Normalised here too, so no caller can hand the rules a CRLF text.
  const files: Files = { compose: lf(input.compose), caddy: lf(input.caddy), prod: lf(input.prod) };
  const found: string[] = [];
  const fail = (rule: string) => found.push(rule);
  const compose = code(files.compose);
  const blocks = services(files.compose);

  // --- The overlay as a whole -------------------------------------------------
  if (!/^name:\s*enginora-preview\s*$/m.test(compose)) fail('project-name');
  if (/\bports\s*:/.test(compose)) fail('no-ports');
  if (/\b(MALWARE_SCANNER|CLAMAV_HOST|CLAMAV_PORT|NODE_ENV)\b/.test(compose)) fail('scanner-env');
  // Anchors, aliases, merge keys, includes and flow mappings (`${VAR}` is
  // interpolation, not a mapping) are things the line reader cannot follow.
  if (/(^|\s)[&*][A-Za-z]|<<\s*:|^\s*(extends|include)\s*:|(^|[^$])\{/m.test(compose)) {
    fail('plain-yaml');
  }
  if (/\b(network_mode|privileged|aliases|hostname|extra_hosts|networks)\s*:/.test(compose)) {
    fail('no-network-tricks');
  }
  if (/minioadmin/i.test(compose)) fail('no-default-credentials');

  for (const [name, block] of blocks) {
    const allowed = ALLOWED_SERVICE_KEYS[name];
    if (!allowed) {
      fail(`unknown-service:${name}`);
      continue;
    }
    for (const key of keysOf(block)) {
      if (!allowed.includes(key)) fail(`key:${name}.${key}`);
    }
  }

  // --- ClamAV: not started, and not replaced --------------------------------
  const clamav = (blocks.get('clamav') ?? []).join('\n');
  if (!/profiles:\s*\[\s*'clamav'\s*\]/.test(clamav)) fail('clamav-not-started');

  // --- The tunnel: off by default, survives no reboot, enters through Caddy --
  const tunnel = (blocks.get('cloudflared') ?? []).join('\n');
  if (!/profiles:\s*\[\s*'tunnel'\s*\]/.test(tunnel)) fail('tunnel-opt-in');
  if (!/restart:\s*'no'/.test(tunnel)) fail('tunnel-no-restart');
  const urls = [...tunnel.matchAll(/'--url',\s*'([^']+)'/g)].map((match) => match[1]);
  if (urls.length !== 1 || urls[0] !== 'http://caddy:8080') fail('tunnel-target');

  // --- Caddy mounts the preview file, not the production one ----------------
  const caddyService = (blocks.get('caddy') ?? []).join('\n');
  if (!caddyService.includes('./deploy/Caddyfile.preview:/etc/caddy/Caddyfile:ro')) {
    fail('caddy-config');
  }

  // --- The production file the overlay leans on ------------------------------
  const prod = code(files.prod);
  if (!/^\s+MALWARE_SCANNER:\s*clamav\s*$/m.test(prod)) fail('prod-scanner');
  if (!/^\s+NODE_ENV:\s*production\s*$/m.test(prod)) fail('prod-node-env');
  const published = [...prod.matchAll(/^\s+-\s*'([^']*:\d+)'\s*$/gm)].map((match) => match[1] ?? '');
  if (published.length === 0 || published.some((port) => !port.startsWith('127.0.0.1:'))) {
    fail('prod-loopback');
  }

  // --- Caddy: internal, plain HTTP, and the client IP from Cloudflare only ---
  const caddy = code(files.caddy);
  if (!/^\s*admin off\s*$/m.test(caddy)) fail('caddy-admin');
  if (!/^\s*auto_https off\s*$/m.test(caddy)) fail('caddy-auto-https');
  if (!/^:8080 \{$/m.test(caddy)) fail('caddy-listener');
  if (/^\s*tls\b/m.test(caddy)) fail('caddy-tls');
  const upstreams = [...caddy.matchAll(/^\s*reverse_proxy\s+(\S+)/gm)].map((match) => match[1]);
  if (upstreams.length !== 1 || upstreams[0] !== 'app:3000') fail('caddy-upstream');
  if (!/^\s*header_up X-Forwarded-For \{http\.request\.header\.CF-Connecting-IP\}\s*$/m.test(caddy)) {
    fail('caddy-client-ip');
  }
  if (!/^\s*header_up X-Forwarded-Proto https\s*$/m.test(caddy)) fail('caddy-proto');
  if (
    !/^\s*@notFromTunnel not header_regexp CF-Connecting-IP \^\[0-9A-Fa-f:\.\]\+\$\s*$/m.test(caddy)
    || !/^\s*respond @notFromTunnel 403\s*$/m.test(caddy)
  ) {
    fail('caddy-tunnel-only');
  }
  // The app sends its own CSP with a per-response nonce; a header set here
  // would replace it. `header_up` and `header_regexp` are not this directive.
  if (/^\s*header\s/m.test(caddy)) fail('caddy-no-headers');

  return found;
}

describe('docker-compose.preview.yml keeps the scanner mandatory and the laptop closed', () => {
  it('the files in the repository satisfy every rule', () => {
    expect(violations(FILES)).toEqual([]);
  });

  it('a Windows checkout (CRLF) satisfies them the same way', () => {
    expect(violations(asCrlf(FILES))).toEqual([]);
  });

  it('the line reader sees the services the overlay defines', () => {
    // If the overlay's layout drifted out of what `services()` understands,
    // every per-service rule would pass vacuously. Pin what it must find.
    expect([...services(FILES.compose).keys()].sort()).toEqual(
      Object.keys(ALLOWED_SERVICE_KEYS).sort(),
    );
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
    {
      defect: 'MALWARE_SCANNER=none given to the app',
      file: 'compose',
      from: '  app:\n',
      to: '  app:\n    environment:\n      MALWARE_SCANNER: none\n',
      rule: 'scanner-env',
    },
    {
      defect: 'the app pointed at another scanner host',
      file: 'compose',
      from: '  app:\n',
      to: '  app:\n    environment:\n      CLAMAV_HOST: stub\n',
      rule: 'scanner-env',
    },
    {
      defect: 'clamav replaced by a stub image',
      file: 'compose',
      from: "    profiles: ['clamav']\n",
      to: "    profiles: ['clamav']\n    image: example/always-ok\n",
      rule: 'key:clamav.image',
    },
    {
      defect: 'clamav started by default',
      file: 'compose',
      from: "    profiles: ['clamav']\n",
      to: '    restart: unless-stopped\n',
      rule: 'clamav-not-started',
    },
    {
      defect: 'a new service answering as `clamav`',
      file: 'compose',
      from: '  caddy:\n',
      to: '  fakescan:\n    image: example/always-ok\n  caddy:\n',
      rule: 'unknown-service:fakescan',
    },
    {
      defect: 'a network alias named clamav',
      file: 'compose',
      from: '    image: rustfs/rustfs:1.0.0\n',
      to: '    image: rustfs/rustfs:1.0.0\n    networks:\n      scanner:\n        aliases: [clamav]\n',
      rule: 'no-network-tricks',
    },
    {
      defect: 'RustFS published',
      file: 'compose',
      from: '    image: rustfs/rustfs:1.0.0\n',
      to: "    image: rustfs/rustfs:1.0.0\n    ports:\n      - '9000:9000'\n",
      rule: 'no-ports',
    },
    {
      defect: 'PostgreSQL published on every interface',
      file: 'compose',
      from: 'services:\n',
      to: "services:\n  postgres:\n    ports:\n      - '5432:5432'\n",
      rule: 'no-ports',
    },
    {
      defect: 'Caddy published',
      file: 'compose',
      from: '    image: caddy:2.10.2\n',
      to: "    image: caddy:2.10.2\n    ports:\n      - '80:8080'\n",
      rule: 'no-ports',
    },
    {
      defect: 'cloudflared published',
      file: 'compose',
      from: '    image: cloudflare/cloudflared:2026.9.1\n',
      to: "    image: cloudflare/cloudflared:2026.9.1\n    ports:\n      - '20241:20241'\n",
      rule: 'no-ports',
    },
    {
      defect: 'the tunnel started by default',
      file: 'compose',
      from: "    profiles: ['tunnel']\n",
      to: '',
      rule: 'tunnel-opt-in',
    },
    {
      defect: 'the tunnel restarting after a reboot',
      file: 'compose',
      from: "    restart: 'no'\n",
      to: '    restart: unless-stopped\n',
      rule: 'tunnel-no-restart',
    },
    {
      defect: 'the tunnel aimed past Caddy at the app',
      file: 'compose',
      from: "'--url', 'http://caddy:8080'",
      to: "'--url', 'http://app:3000'",
      rule: 'tunnel-target',
    },
    {
      defect: 'the development server behind the tunnel',
      file: 'compose',
      from: '  app:\n',
      to: "  app:\n    command: ['npm', 'run', 'dev']\n",
      rule: 'key:app.command',
    },
    {
      defect: 'the project name dropped (shares the dev database volume)',
      file: 'compose',
      from: 'name: enginora-preview\n',
      to: '',
      rule: 'project-name',
    },
    {
      defect: 'default storage credentials',
      file: 'compose',
      from: /\$\{STORAGE_ACCESS_KEY_ID:\?set STORAGE_ACCESS_KEY_ID\}/,
      to: 'minioadmin',
      rule: 'no-default-credentials',
    },
    {
      defect: 'a YAML anchor smuggling settings in',
      file: 'compose',
      from: '  storage:\n',
      to: '  storage: &shared\n',
      rule: 'plain-yaml',
    },
    {
      defect: 'production told `none`',
      file: 'prod',
      from: 'MALWARE_SCANNER: clamav',
      to: 'MALWARE_SCANNER: none',
      rule: 'prod-scanner',
    },
    {
      defect: 'production postgres on every interface',
      file: 'prod',
      from: "'127.0.0.1:5432:5432'",
      to: "'5432:5432'",
      rule: 'prod-loopback',
    },
    {
      defect: 'Caddy trusting the visitor X-Forwarded-For',
      file: 'caddy',
      from: /^\s*header_up X-Forwarded-For .*\n/m,
      to: '',
      rule: 'caddy-client-ip',
    },
    {
      defect: 'Caddy accepting requests that bypassed the tunnel',
      file: 'caddy',
      from: /^\s*respond @notFromTunnel 403\n/m,
      to: '',
      rule: 'caddy-tunnel-only',
    },
    {
      defect: 'Caddy accepting an empty CF-Connecting-IP',
      file: 'caddy',
      from: 'not header_regexp CF-Connecting-IP ^[0-9A-Fa-f:.]+$',
      to: 'not header CF-Connecting-IP *',
      rule: 'caddy-tunnel-only',
    },
    {
      defect: 'Caddy admin endpoint on',
      file: 'caddy',
      from: /^\s*admin off\n/m,
      to: '',
      rule: 'caddy-admin',
    },
    {
      defect: 'Caddy proxying to storage',
      file: 'caddy',
      from: 'reverse_proxy app:3000',
      to: 'reverse_proxy storage:9000',
      rule: 'caddy-upstream',
    },
    {
      defect: 'Caddy overwriting the CSP',
      file: 'caddy',
      from: '\treverse_proxy app:3000 {\n',
      to: '\theader Content-Security-Policy "default-src *"\n\treverse_proxy app:3000 {\n',
      rule: 'caddy-no-headers',
    },
  ];

  it.each(mutations)('$defect → $rule', ({ file, from, to, rule }) => {
    const mutated = FILES[file].replace(from, to);
    // A mutation that changes nothing proves nothing.
    expect(mutated, 'the mutation did not apply').not.toBe(FILES[file]);
    expect(violations({ ...FILES, [file]: mutated })).toContain(rule);
    // And caught the same way when it arrives in a CRLF checkout.
    expect(violations(asCrlf({ ...FILES, [file]: mutated }))).toContain(rule);
  });
});
