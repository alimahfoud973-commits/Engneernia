/**
 * The dependency-audit gate for CI: every HIGH or CRITICAL advisory fails the
 * build, except an advisory listed in EXCEPTIONS below — and an exception is
 * only honoured while every one of its claims is still true.
 *
 * Why not plain `npm audit --audit-level=high`: it has no way to accept one
 * reviewed advisory, so a single unfixable dev-tool advisory (GHSA-vfj7-8cjw-
 * p6xm, `braces`, docs/DECISIONS.md TD-50) keeps CI red forever — and a CI
 * that is always red hides the next real failure.
 *
 * Why not `--omit=dev` alone: that drops every dev-tool advisory, including
 * the next one nobody has looked at. CI runs `npm audit --omit=dev
 * --audit-level=high` as a separate step with no exceptions at all; this gate
 * covers everything else.
 *
 * An exception FAILS the gate when:
 *   - it has expired (and it may not be written for more than 90 days);
 *   - its advisory no longer appears (fixed upstream: delete the exception);
 *   - the vulnerable package is now reached by any path other than the one
 *     reviewed, or the path ends in something other than a devDependency.
 * A guard that cannot fail is not a guard: scripts/audit-gate.test.ts proves
 * each of these.
 *
 * Usage:  node scripts/audit-gate.mjs [--report audit.json] [--today YYYY-MM-DD]
 * Without --report it runs `npm audit --json` itself.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EXCEPTIONS = [
  {
    advisory: 'GHSA-vfj7-8cjw-p6xm',
    package: 'braces',
    // From the vulnerable package up to the direct dependency, exactly as
    // `npm audit` links them through `effects`.
    path: ['braces', 'micromatch', 'fast-glob', '@next/eslint-plugin-next', 'eslint-config-next'],
    devOnly: true,
    reviewed: '2026-10-04',
    expires: '2026-12-03',
    reason:
      'Every braces release is affected and none is fixed (3.0.3 is the latest). It reaches the ' +
      'project only through eslint-config-next, a lint-time devDependency that globs the ' +
      "project's own rootDir; nothing of it ships to production (npm audit --omit=dev = 0). " +
      "npm's only proposal is eslint-config-next@14, two majors back. See docs/DECISIONS.md TD-50.",
  },
];

const BLOCKING = new Set(['high', 'critical']);
const MAX_EXCEPTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function advisoryId(via) {
  const match = typeof via.url === 'string' ? via.url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/) : null;
  return match ? match[0] : `npm:${via.source}`;
}

/** Every chain from `name` up `effects` to a direct dependency. */
function chainsUp(vulnerabilities, name, seen = []) {
  const entry = vulnerabilities[name];
  if (!entry || seen.includes(name)) return [[...seen, name, '<unresolved>']];
  const here = [...seen, name];
  const chains = [];
  if (entry.isDirect) chains.push(here);
  for (const parent of entry.effects ?? []) chains.push(...chainsUp(vulnerabilities, parent, here));
  return chains.length > 0 ? chains : [[...here, '<not a direct dependency>']];
}

/**
 * Pure decision: given an `npm audit --json` report, the exceptions, today's
 * date and the project's manifest, list what fails the gate.
 */
function evaluate(report, { exceptions, today, manifest }) {
  const problems = [];
  const exempted = [];

  if (!report || report.auditReportVersion !== 2 || typeof report.vulnerabilities !== 'object') {
    return { problems: ['The audit report is not an npm v2 report — refusing to pass blind.'], exempted };
  }
  if (!isIsoDate(today)) return { problems: [`Invalid --today: ${today}`], exempted };

  for (const exception of exceptions) {
    if (!isIsoDate(exception.reviewed) || !isIsoDate(exception.expires) || !exception.reason) {
      problems.push(`Exception ${exception.advisory}: needs a reviewed date, an expiry date and a reason.`);
      continue;
    }
    const days = (Date.parse(exception.expires) - Date.parse(exception.reviewed)) / DAY_MS;
    if (days > MAX_EXCEPTION_DAYS) {
      problems.push(`Exception ${exception.advisory}: valid for ${days} days; the limit is ${MAX_EXCEPTION_DAYS}.`);
    }
    if (today > exception.expires) {
      problems.push(
        `Exception ${exception.advisory} (${exception.package}) expired on ${exception.expires}: ` +
          'review it again — fixed upstream? still dev-only? — then renew or remove it.',
      );
    }
  }

  const advisories = [];
  for (const entry of Object.values(report.vulnerabilities)) {
    for (const via of entry.via ?? []) {
      if (typeof via === 'object' && via !== null) {
        advisories.push({ id: advisoryId(via), package: via.name, severity: via.severity, title: via.title });
      }
    }
  }

  for (const exception of exceptions) {
    if (!advisories.some((a) => a.id === exception.advisory && a.package === exception.package)) {
      problems.push(
        `Exception ${exception.advisory} (${exception.package}) matches nothing in the audit any more: ` +
          'the advisory is gone, so delete the exception.',
      );
    }
  }

  const devDependencies = manifest.devDependencies ?? {};
  const dependencies = manifest.dependencies ?? {};

  for (const advisory of advisories) {
    if (!BLOCKING.has(advisory.severity)) continue;
    const label = `${advisory.severity.toUpperCase()} ${advisory.id} in ${advisory.package} — ${advisory.title ?? ''}`.trim();
    const exception = exceptions.find((e) => e.advisory === advisory.id && e.package === advisory.package);
    if (!exception) {
      problems.push(`Unreviewed ${label}`);
      continue;
    }

    const expected = exception.path.join(' > ');
    const chains = chainsUp(report.vulnerabilities, advisory.package).map((c) => c.join(' > '));
    const unexpected = chains.filter((chain) => chain !== expected);
    if (unexpected.length > 0) {
      problems.push(`${label}: reached by a path the exception does not cover: ${unexpected.join('; ')}`);
      continue;
    }

    const root = exception.path[exception.path.length - 1];
    if (exception.devOnly && (!(root in devDependencies) || root in dependencies)) {
      problems.push(`${label}: ${root} is no longer a devDependency only, so the exception no longer holds.`);
      continue;
    }

    // An expired exception is already a problem above; it excuses nothing.
    if (today <= exception.expires) exempted.push(`${label} — excepted until ${exception.expires} (${expected})`);
  }

  return { problems: [...new Set(problems)], exempted };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function runNpmAudit() {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  // `npm audit` exits non-zero whenever it finds anything; the JSON is what counts.
  return result.stdout;
}

function main() {
  const reportPath = argument('--report');
  const today = argument('--today') ?? new Date().toISOString().slice(0, 10);

  let report;
  try {
    report = JSON.parse(reportPath ? readFileSync(reportPath, 'utf8') : runNpmAudit());
  } catch (error) {
    console.error(`✗ Could not read an audit report: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { problems, exempted } = evaluate(report, { exceptions: EXCEPTIONS, today, manifest });

  for (const line of exempted) console.log(`• ${line}`);
  if (problems.length > 0) {
    console.error(['', '✗ Dependency audit gate failed:', ...problems.map((p) => `  - ${p}`), ''].join('\n'));
    process.exit(1);
  }
  console.log('✓ No unreviewed HIGH or CRITICAL advisories.');
}

main();
