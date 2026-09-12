import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ===========================================================================
 * SERVER COMPONENTS DO NOT IMPORT VALUES FROM CLIENT MODULES
 * ===========================================================================
 * A module marked `'use client'` is a boundary. A server component importing a
 * value from it receives a CLIENT REFERENCE, not the value — so a label map
 * resolves to `undefined` and the page renders the raw enum key.
 *
 * That shipped: the adjustments console showed BANK_FEE_OR_SHORTFALL to the
 * owner where it should have said "رسوم أو نقص تحويل". No error, no type
 * complaint, no failing test — it was found by photographing the page.
 *
 * Components are exempt: importing a COMPONENT across the boundary is the
 * whole point of `'use client'`. The rule is about plain values.
 * ===========================================================================
 */

const CLIENT_DIRECTIVE = /^\s*(['"])use client\1\s*;?/;

/** A component by convention: exported name starts with a capital letter. */
function looksLikeComponent(name: string): boolean {
  return /^[A-Z]/.test(name) && !/^[A-Z0-9_]+$/.test(name);
}

function clientModules(): Set<string> {
  const found = new Set<string>();
  for (const file of globSync('src/**/*.{ts,tsx}', { cwd: process.cwd() })) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    if (CLIENT_DIRECTIVE.test(source)) {
      found.add(file.replace(/^src\//, '@/').replace(/\.tsx?$/, ''));
    }
  }
  return found;
}

describe('the client boundary', () => {
  const clients = clientModules();

  it('finds the client modules at all', () => {
    expect(clients.size).toBeGreaterThan(0);
  });

  it('no server component imports a plain VALUE from a client module', () => {
    const offenders: string[] = [];

    for (const file of globSync('src/**/*.tsx', { cwd: process.cwd() })) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      if (CLIENT_DIRECTIVE.test(source)) continue; // a client importing a client is fine

      for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
        const specifier = match[2]!;
        if (!clients.has(specifier)) continue;

        for (const raw of match[1]!.split(',')) {
          const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
          if (!name || name.startsWith('type ')) continue;
          if (looksLikeComponent(name)) continue;
          offenders.push(`${file} imports ${name} from ${specifier}`);
        }
      }
    }

    expect(
      offenders,
      'a server component cannot read a value across the "use client" boundary — '
      + `move it to a plain module:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
