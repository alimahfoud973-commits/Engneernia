import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EVERY KNOB IS DECLARED, SO THE PLATFORM MOVES WITHOUT BEING EDITED.
 *
 * The owner's standing requirement: a server, an S3-compatible store, a real
 * mail provider and a domain must all be connectable later through
 * configuration, with no code change. That property is easy to state and easy
 * to lose — not by anyone deciding against it, but by one `process.env.X`
 * added in passing, in a module far from `env.ts`.
 *
 * A variable read that way is invisible three ways: it is in no template, so
 * nobody knows to set it; it is in no schema, so a typo is not caught at boot;
 * and it is in no document, so connecting the service it belongs to means
 * reading the source. That is precisely a deployment that needs a developer.
 *
 * Found two of them: CLAMAV_HOST and CLAMAV_PORT, which selected and addressed
 * the malware scanner and appeared in no template, no schema and no runbook.
 */

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|itest)\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

/**
 * Read straight from the process, by necessity rather than by convenience.
 * Each of these runs before or outside the validated environment: `env.ts` is
 * where validation happens, and the middleware and logger are reached on paths
 * that must not import a `server-only` module.
 */
const BOOTSTRAP_READS = new Set(['NODE_ENV', 'NEXT_RUNTIME']);

/** The names `env.ts` declares — the single list an operator has to fill in. */
function declaredInSchema(): Set<string> {
  const source = read('src/lib/config/env.ts');
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

describe('configuration is declared in one place', () => {
  it('reads no environment variable that the schema does not declare', () => {
    const declared = declaredInSchema();
    const offenders: string[] = [];

    for (const path of walk('src')) {
      if (path === 'src/lib/config/env.ts') continue;
      for (const match of read(path).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        const name = match[1];
        if (!name || declared.has(name) || BOOTSTRAP_READS.has(name)) continue;
        offenders.push(`${path}: ${name}`);
      }
    }

    expect(
      offenders,
      'undeclared environment reads — declare them in src/lib/config/env.ts and the '
      + `env templates, or the service behind them cannot be connected without editing code:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('declares every schema variable in the environment templates too', () => {
    // A variable that is validated but undocumented still forces a reader into
    // the source to find out what to set.
    const templates = read('.env.example');
    const missing = [...declaredInSchema()].filter((name) => !templates.includes(name));
    expect(missing, `declared in env.ts but absent from .env.example: ${missing.join(', ')}`)
      .toEqual([]);
  });
});
