import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ===========================================================================
 * NO ROUTE HANDS BACK A DATABASE ROW
 * ===========================================================================
 * CLAUDE.md's sixth rule says an entity is never returned from a route and is
 * converted through `toPublic` / `toContributor` / `toOwner` first, with
 * financial fields ABSENT rather than hidden.
 *
 * Those three functions do not exist and never did. The PROPERTY they describe
 * does hold — verified before this test was written — but by three other
 * mechanisms: routes return bytes or an error code and never serialise a row;
 * reads select explicit columns rather than whole entities; and row-level
 * security decides which rows resolve at all underneath both.
 *
 * A rule that names machinery nobody built is worse than no rule: the next
 * person looks for `toPublic`, does not find it, and concludes the rule is
 * decorative. So the rule now describes what is really there, and this test
 * makes the two checkable halves of it fail the build rather than rely on
 * everyone remembering.
 * ===========================================================================
 */

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function routeFiles(dir = 'src/app/api', out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) routeFiles(rel, out);
    else if (entry === 'route.ts') out.push(rel);
  }
  return out;
}

/**
 * The one JSON body that is not an error envelope, and why.
 *
 * `/api/health` answers a load balancer with liveness, which is not a row and
 * belongs to nobody. Named here so a second exception has to be argued rather
 * than added.
 */
const NOT_AN_ERROR_ENVELOPE = new Set(['src/app/api/health/route.ts']);

describe('the sixth rule, as the code actually keeps it', () => {
  it('returns only an error code as JSON — never a row', () => {
    const offenders: string[] = [];

    for (const path of routeFiles()) {
      if (NOT_AN_ERROR_ENVELOPE.has(path)) continue;
      for (const match of read(path).matchAll(/NextResponse\.json\(\s*([^,)]*)/g)) {
        const body = (match[1] ?? '').trim();
        // `{ error: … }` is the whole contract: a stable code, nothing else.
        if (/^\{\s*error:/.test(body)) continue;
        offenders.push(`${path}: ${body.slice(0, 60)}`);
      }
    }

    expect(
      offenders,
      'a route returned something other than an error envelope — if it is a domain '
      + `object, that is the sixth rule broken:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps every financial column out of the public catalogue queries', () => {
    /**
     * ABSENT, not hidden. These modules feed the pages an anonymous visitor
     * and a signed-in engineer both reach; a commission or a platform cut
     * selected here would travel to the browser inside the server-rendered
     * payload whether or not anything displayed it.
     */
    const FINANCIAL = [
      'platformAmountMinor', 'platform_amount_minor',
      'engineerAmountMinor', 'engineer_amount_minor',
      'engineerBp', 'engineer_bp',
      'commissionBp', 'commission_bp',
      'netMinor', 'net_minor',
    ];

    const offenders: string[] = [];
    for (const path of ['src/catalog/public-queries.ts', 'src/catalog/search.ts']) {
      const source = read(path);
      for (const column of FINANCIAL) {
        if (source.includes(column)) offenders.push(`${path}: ${column}`);
      }
    }

    expect(offenders, `financial column in a public query:\n  ${offenders.join('\n  ')}`)
      .toEqual([]);
  });
});
