import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE DEVELOPMENT STACK LISTENS ON THIS MACHINE ONLY.
 *
 * docker-compose.yml runs PostgreSQL with `postgres`/`postgres` as superuser
 * and RustFS with `minioadmin`/`minioadmin`, and both are published in this
 * public repository. Those values are tolerable only because nothing off the
 * developer's machine can reach them. A bare `'5432:5432'` publishes the port
 * on every interface, so a laptop on a café or hotel network hands a
 * superuser connection to anyone sharing it. That is what docker-compose.yml
 * did until this file existed.
 *
 * Nothing legitimate needs these ports from another device: the app,
 * migrations, seeds, prove-rls, backups and the integration tests all connect
 * through `localhost`, and a phone testing the site reaches Next on port 3000,
 * never the database or the storage (docs/RUN-LOCALLY.md §٦).
 *
 * Covered: every `ports:` entry in docker-compose.yml, and every
 * `docker run -p` the documentation tells someone to type (the integration
 * test database of RUN-LOCALLY.md §١٠). The production and preview files have
 * their own guard in preview-stack.test.ts.
 *
 * Read as text, like preview-stack.test.ts: the repository has no YAML parser
 * as a direct dependency. Port syntax the reader cannot follow (the long
 * `target:`/`published:` form) is refused rather than half-understood.
 * The negative cases re-introduce each defect into an in-memory copy and
 * require the rule to fire, in LF and in CRLF.
 */

const root = process.cwd();

/** Every line break as LF; Git for Windows checks these files out with CRLF. */
const lf = (text: string) => text.replace(/\r\n?/g, '\n');
const read = (path: string) => lf(readFileSync(join(root, path), 'utf8'));

const docPaths = readdirSync(join(root, 'docs'))
  .filter((name) => name.endsWith('.md'))
  .map((name) => `docs/${name}`)
  .sort();

type Files = { readonly compose: string; readonly docs: Readonly<Record<string, string>> };

const FILES: Files = {
  compose: read('docker-compose.yml'),
  docs: Object.fromEntries(docPaths.map((path) => [path, read(path)])),
};

const asCrlf = (files: Files): Files => ({
  compose: lf(files.compose).replace(/\n/g, '\r\n'),
  docs: Object.fromEntries(
    Object.entries(files.docs).map(([path, text]) => [path, lf(text).replace(/\n/g, '\r\n')]),
  ),
});

/** `HOST_IP:HOST_PORT:CONTAINER_PORT`, loopback only, optional protocol. */
const LOOPBACK = /^127\.0\.0\.1:\d+:\d+(\/(tcp|udp))?$/;

/** The text with `#` comments removed, so prose can name what code may not. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');
}

const unquote = (value: string) => value.trim().replace(/^['"]|['"]$/g, '');

/** Every published port entry in a compose file; `null` marks a form it cannot read. */
function publishedPorts(yaml: string): (string | null)[] {
  const entries: (string | null)[] = [];
  const lines = code(lf(yaml)).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)ports:\s*(.*)$/.exec(lines[i] ?? '');
    if (!head) continue;
    const indent = head[1]?.length ?? 0;
    const inline = head[2]?.trim() ?? '';
    if (inline !== '') {
      // Flow form: ports: ['5432:5432', ...]
      const flow = /^\[(.*)\]$/.exec(inline);
      if (!flow) {
        entries.push(null);
        continue;
      }
      for (const item of (flow[1] ?? '').split(',')) {
        if (item.trim() !== '') entries.push(unquote(item));
      }
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? '';
      if (line.trim() === '') continue;
      if ((/^(\s*)/.exec(line)?.[1]?.length ?? 0) <= indent) break;
      const item = /^\s*-\s*(.+)$/.exec(line);
      // The long form (`- target: 5432` / `published:` / `host_ip:`) and
      // anything else that is not a plain string entry.
      entries.push(item?.[1] && !/^[\w-]+\s*:\s/.test(item[1]) ? unquote(item[1]) : null);
    }
  }
  return entries;
}

/** The value of every `-p` / `--publish` given to `docker run` in a document. */
function documentedPublishes(markdown: string): string[] {
  const found: string[] = [];
  // A command may continue over lines with PowerShell's backtick or a shell
  // backslash; join those so the flags stay with their `docker run`.
  const joined = lf(markdown).replace(/[`\\]\n/g, ' ');
  for (const line of joined.split('\n')) {
    if (!/\bdocker\s+(container\s+)?(run|create)\b/.test(line)) continue;
    for (const match of line.matchAll(/(?:^|\s)(?:-p|--publish)(?:\s+|=)(\S+)/g)) {
      found.push(unquote(match[1] ?? ''));
    }
  }
  return found;
}

/** Every rule. Empty means nothing is published beyond this machine. */
function violations(input: Files): string[] {
  const found: string[] = [];
  const ports = publishedPorts(input.compose);
  if (ports.length === 0) found.push('compose:no-ports-found');
  for (const port of ports) {
    if (port === null) found.push('compose:unreadable-ports');
    else if (!LOOPBACK.test(port)) found.push(`compose:${port}`);
  }
  for (const [path, text] of Object.entries(input.docs)) {
    for (const port of documentedPublishes(text)) {
      if (!LOOPBACK.test(port)) found.push(`${path}:${port}`);
    }
  }
  return found;
}

describe('docker-compose.yml and the documented containers listen on 127.0.0.1 only', () => {
  it('the files in the repository satisfy every rule', () => {
    expect(violations(FILES)).toEqual([]);
  });

  it('a Windows checkout (CRLF) satisfies them the same way', () => {
    expect(violations(asCrlf(FILES))).toEqual([]);
  });

  it('the reader sees the ports the files publish', () => {
    // If the layout drifted out of what the reader understands, the rules
    // would pass vacuously. Pin what it must find.
    expect(publishedPorts(FILES.compose)).toEqual([
      '127.0.0.1:5432:5432',
      '127.0.0.1:9000:9000',
      '127.0.0.1:9001:9001',
    ]);
    expect(documentedPublishes(FILES.docs['docs/RUN-LOCALLY.md'] ?? '')).toEqual([
      '127.0.0.1:5433:5432',
    ]);
  });
});

describe('each guard fails when its defect is re-introduced', () => {
  type Mutation = {
    readonly defect: string;
    readonly file: 'compose' | 'docs/RUN-LOCALLY.md';
    readonly from: string;
    readonly to: string;
    readonly rule: string;
  };

  const mutations: readonly Mutation[] = [
    {
      defect: 'PostgreSQL on every interface',
      file: 'compose',
      from: "- '127.0.0.1:5432:5432'",
      to: "- '5432:5432'",
      rule: 'compose:5432:5432',
    },
    {
      defect: 'PostgreSQL on 0.0.0.0, spelled out',
      file: 'compose',
      from: "- '127.0.0.1:5432:5432'",
      to: "- '0.0.0.0:5432:5432'",
      rule: 'compose:0.0.0.0:5432:5432',
    },
    {
      defect: 'the S3 API on every interface',
      file: 'compose',
      from: "- '127.0.0.1:9000:9000'",
      to: "- '9000:9000'",
      rule: 'compose:9000:9000',
    },
    {
      defect: 'the storage console on every IPv6 interface',
      file: 'compose',
      from: "- '127.0.0.1:9001:9001'",
      to: "- '[::]:9001:9001'",
      rule: 'compose:[::]:9001:9001',
    },
    {
      defect: 'a port published in flow form',
      file: 'compose',
      from: "    ports:\n      # Loopback only. Everything",
      to: "    ports: ['5432:5432']\n    labels:\n      # Loopback only. Everything",
      rule: 'compose:5432:5432',
    },
    {
      defect: 'a port in the long form the reader cannot check',
      file: 'compose',
      from: "- '127.0.0.1:9000:9000'",
      to: '- target: 9000\n        published: 9000',
      rule: 'compose:unreadable-ports',
    },
    {
      defect: 'the integration test database on every interface',
      file: 'docs/RUN-LOCALLY.md',
      from: '-p 127.0.0.1:5433:5432',
      to: '-p 5433:5432',
      rule: 'docs/RUN-LOCALLY.md:5433:5432',
    },
  ];

  const apply = (files: Files, { file, from, to }: Mutation): Files =>
    file === 'compose'
      ? { ...files, compose: files.compose.replace(from, to) }
      : { ...files, docs: { ...files.docs, [file]: (files.docs[file] ?? '').replace(from, to) } };

  it.each(mutations)('$defect → $rule', (mutation) => {
    const mutated = apply(FILES, mutation);
    // A mutation that changes nothing proves nothing.
    expect(mutated, 'the mutation did not apply').not.toEqual(FILES);
    expect(violations(mutated)).toContain(mutation.rule);
    // And caught the same way when it arrives in a CRLF checkout.
    expect(violations(asCrlf(mutated))).toContain(mutation.rule);
  });
});
