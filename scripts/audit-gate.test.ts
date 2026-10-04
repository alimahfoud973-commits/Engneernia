import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The audit gate is run exactly as CI runs it — a separate `node` process —
 * against audit reports shaped like real `npm audit --json` (v2) output. Each
 * case below is a way the single reviewed exception could stop being true;
 * every one of them must turn the gate red.
 */

const SCRIPT = join(process.cwd(), 'scripts/audit-gate.mjs');
const BRACES = 'GHSA-vfj7-8cjw-p6xm';
const VALID_DAY = '2026-10-04';

type Entry = Record<string, unknown>;

function advisory(name: string, ghsa: string, severity: string) {
  return {
    source: 1,
    name,
    dependency: name,
    title: `${name} advisory`,
    url: `https://github.com/advisories/${ghsa}`,
    severity,
    range: '*',
  };
}

function link(name: string, via: string, effects: string[], isDirect = false): Entry {
  return { name, severity: 'high', isDirect, via: [via], effects, range: '*', nodes: [`node_modules/${name}`] };
}

/** Today's real report: the braces chain (high) and drizzle-kit's esbuild (moderate). */
function realisticReport(): { auditReportVersion: number; vulnerabilities: Record<string, Entry> } {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      braces: {
        name: 'braces',
        severity: 'high',
        isDirect: false,
        via: [advisory('braces', BRACES, 'high')],
        effects: ['micromatch'],
        range: '*',
        nodes: ['node_modules/braces'],
      },
      micromatch: link('micromatch', 'braces', ['fast-glob']),
      'fast-glob': link('fast-glob', 'micromatch', ['@next/eslint-plugin-next']),
      '@next/eslint-plugin-next': link('@next/eslint-plugin-next', 'fast-glob', ['eslint-config-next']),
      'eslint-config-next': link('eslint-config-next', '@next/eslint-plugin-next', [], true),
      esbuild: {
        name: 'esbuild',
        severity: 'moderate',
        isDirect: false,
        via: [advisory('esbuild', 'GHSA-67mh-4wv8-2f99', 'moderate')],
        effects: ['drizzle-kit'],
        range: '<=0.24.2',
        nodes: ['node_modules/esbuild'],
      },
      'drizzle-kit': { ...link('drizzle-kit', 'esbuild', [], true), severity: 'moderate' },
    },
  };
}

type Report = ReturnType<typeof realisticReport>;

/** A named entry of the report — the fixture always has it; say so loudly if not. */
function at(report: Report, name: string): Entry {
  const entry = report.vulnerabilities[name];
  if (!entry) throw new Error(`fixture has no ${name}`);
  return entry;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'audit-gate-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;
async function gate(report: unknown, today = VALID_DAY) {
  const file = join(dir, `report-${counter++}.json`);
  await writeFile(file, typeof report === 'string' ? report : JSON.stringify(report));
  const result = spawnSync(process.execPath, [SCRIPT, '--report', file, '--today', today], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('audit gate — the one reviewed exception', () => {
  it('passes today’s report: braces excepted on its reviewed path, moderates ignored', async () => {
    const { status, output } = await gate(realisticReport());
    expect(status).toBe(0);
    expect(output).toContain(`${BRACES} in braces`);
    expect(output).toContain('braces > micromatch > fast-glob > @next/eslint-plugin-next > eslint-config-next');
  });

  it('still passes on the expiry day itself', async () => {
    expect((await gate(realisticReport(), '2026-12-03')).status).toBe(0);
  });

  it('fails the day after the exception expires', async () => {
    const { status, output } = await gate(realisticReport(), '2026-12-04');
    expect(status).toBe(1);
    expect(output).toContain('expired on 2026-12-03');
    expect(output).not.toContain('excepted until');
  });

  it('fails when the advisory is gone — the exception must then be deleted', async () => {
    const report = realisticReport();
    for (const name of ['braces', 'micromatch', 'fast-glob', '@next/eslint-plugin-next', 'eslint-config-next']) {
      delete report.vulnerabilities[name];
    }
    const { status, output } = await gate(report);
    expect(status).toBe(1);
    expect(output).toContain('matches nothing in the audit any more');
  });

  it('fails when braces is also reached by a path nobody reviewed', async () => {
    const report = realisticReport();
    at(report, 'braces').effects = ['micromatch', 'chokidar'];
    report.vulnerabilities.chokidar = link('chokidar', 'braces', [], true);
    const { status, output } = await gate(report);
    expect(status).toBe(1);
    expect(output).toContain('braces > chokidar');
  });

  it('fails when the reviewed path stops ending in a direct dependency', async () => {
    const report = realisticReport();
    at(report, 'eslint-config-next').isDirect = false;
    const { status, output } = await gate(report);
    expect(status).toBe(1);
    expect(output).toContain('reached by a path the exception does not cover');
  });

  it('fails on a different advisory in the same package', async () => {
    const report = realisticReport();
    (at(report, 'braces').via as unknown[]).push(advisory('braces', 'GHSA-aaaa-bbbb-cccc', 'high'));
    const { status, output } = await gate(report);
    expect(status).toBe(1);
    expect(output).toContain('Unreviewed HIGH GHSA-aaaa-bbbb-cccc in braces');
  });
});

describe('audit gate — everything else is still a gate', () => {
  it.each(['high', 'critical'])('fails on an unreviewed %s advisory', async (severity) => {
    const report = realisticReport();
    report.vulnerabilities['left-pad'] = {
      name: 'left-pad',
      severity,
      isDirect: true,
      via: [advisory('left-pad', 'GHSA-1111-2222-3333', severity)],
      effects: [],
      range: '*',
      nodes: ['node_modules/left-pad'],
    };
    const { status, output } = await gate(report);
    expect(status).toBe(1);
    expect(output).toContain(`Unreviewed ${severity.toUpperCase()} GHSA-1111-2222-3333 in left-pad`);
  });

  it.each([
    ['not JSON', '{ broken'],
    ['an npm error object', { error: { code: 'ENOAUDIT', summary: 'registry unreachable' } }],
    ['an older report format', { auditReportVersion: 1, advisories: {} }],
  ])('fails closed on %s', async (_label, report) => {
    expect((await gate(report)).status).toBe(1);
  });
});
