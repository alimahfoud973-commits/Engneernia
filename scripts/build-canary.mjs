import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

/**
 *   node scripts/build-canary.mjs              does a .env.production leak into .next?
 *   node scripts/build-canary.mjs --self-test  can this script see a leak at all?
 *
 * B7-n1. The Docker build runs `next build`, and `next build` LOADS a
 * .env.production it finds beside it. .dockerignore now keeps that file out of
 * the build context; this asks the other question — if one got in anyway, would
 * any of its values end up in `.next`, which the runtime stage copies into the
 * image?
 *
 * In a throwaway copy of the TRACKED files (so no real env file can come along)
 * with its own node_modules, it writes a .env.production holding every name in
 * .env.production.example, each with a fresh random value that is a secret of
 * nothing. It builds the way the Dockerfile does (NODE_ENV=production, telemetry
 * off, `npm run build` with its prebuild guard), with an environment that holds
 * nothing of the caller's but PATH and HOME. Then it searches every file under
 * `.next`, and the build's own output, for each value. It prints names, file
 * paths and counts — never a value, never a file's content. The copy is removed
 * at the end.
 *
 * The result means something only if the file was really loaded, so a build
 * whose output does not list .env.production under "Environments" is a failure,
 * not a pass. --self-test proves the search: it adds to the copy's next.config
 * the one documented way to put a server value into the build (`env`), and
 * passes only if the search finds that value. That is a test of this script,
 * never a finding about the application.
 *
 * What a clean result does NOT prove: that no secret can ever leak. It covers
 * these names, this commit, values written out verbatim. A value hashed,
 * encoded, or inside a compressed format other than gzip and zstd is not
 * seen — the count of files it could not open is printed so that gap is
 * visible. And it says nothing about Docker's layers, which only a real
 * Docker build can show (docs/PROJECT_STATE.md, B7-n1).
 */
const root = process.cwd();
const selfTest = process.argv.includes('--self-test');
const keep = process.argv.includes('--keep');

const git = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
if (git.status !== 0) {
  console.error('Run this from the repository root: it copies the files git tracks.');
  process.exit(2);
}
const tracked = git.stdout.split('\0').filter(Boolean);
// Belt and braces: only the committed examples may be env files.
const strays = tracked.filter((p) => /(^|\/)\.env($|\.)/.test(p) && !p.endsWith('.example'));
if (strays.length > 0) {
  console.error(`Refusing: git tracks an env file that is not an example: ${strays.join(', ')}`);
  process.exit(2);
}

/*
 * Settings the code parses as soon as a module loads — src/lib/logger.ts hands
 * LOG_LEVEL to pino at module scope, and the build evaluates route modules to
 * collect page data — so a random value would fail the build, not test it.
 * They keep the template's value. None of them is a secret.
 */
const PARSED = new Set(['LOG_LEVEL', 'PLATFORM_TIMEZONE', 'PLATFORM_BASE_CURRENCY', 'MALWARE_SCANNER', 'SEO_INDEXABLE', 'CLAMAV_PORT']);
const template = [...readFileSync(join(root, '.env.production.example'), 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)]
  .filter((m) => m[1] !== 'NODE_ENV');
const canaries = new Map(template.filter((m) => !PARSED.has(m[1])).map((m) => [m[1], randomBytes(16).toString('hex')]));
const valueOf = (name, token) => {
  if (name.startsWith('DATABASE_')) return `postgresql://canary:${token}@canary.test:5432/canary`;
  if (name === 'MAIL_TRANSPORT_URL') return `smtp://canary:${token}@canary.test:587`;
  if (name.endsWith('_URL') || name.endsWith('_ENDPOINT')) return `https://c${token}.test`;
  return token;
};
const redact = (text) => {
  let out = text;
  for (const [name, token] of canaries) out = out.split(token).join(`<canary:${name}>`);
  return out;
};

/** 0 clean (or self-test passed), 1 found (or self-test failed), 2 no verdict. */
function run(work) {
  console.log(`copying ${tracked.length} tracked files and node_modules to a throwaway directory…`);
  for (const path of tracked) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    cpSync(join(root, path), join(work, path));
  }
  cpSync(join(root, 'node_modules'), join(work, 'node_modules'), { recursive: true, verbatimSymlinks: true });

  writeFileSync(
    join(work, '.env.production'),
    template.map(([line, name]) => (canaries.has(name) ? `${name}=${valueOf(name, canaries.get(name))}` : line)).join('\n') + '\n',
  );
  chmodSync(join(work, '.env.production'), 0o600);

  if (selfTest) {
    const config = join(work, 'next.config.ts');
    const text = readFileSync(config, 'utf8');
    const patched = text.replace('const nextConfig: NextConfig = {\n', "const nextConfig: NextConfig = {\n  env: { CANARY_SELF_TEST: process.env.SESSION_SECRET ?? '' },\n");
    if (patched === text) throw new Error('self-test: could not find the config object in next.config.ts');
    writeFileSync(config, patched);
  }

  console.log(`building with ${canaries.size} canary values (and ${PARSED.size} template settings) in .env.production${selfTest ? ' (SELF-TEST: SESSION_SECRET wired into next.config env)' : ''}…`);
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: work,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? work, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
  });
  const log = `${build.stdout ?? ''}\n${build.stderr ?? ''}`;
  if (build.status !== 0) {
    console.error(`build failed (exit ${build.status}); its last lines, canaries redacted:\n${redact(log).split('\n').slice(-30).join('\n')}`);
    return 2;
  }
  const loaded = log.split('\n').some((line) => /Environments:.*\.env\.production\b/.test(line));
  console.log(`next build loaded .env.production: ${loaded ? 'yes' : 'NO'}`);
  if (!loaded) {
    console.error('The build did not report loading .env.production, so finding nothing would mean nothing.');
    return 2;
  }

  const hits = new Map();
  let files = 0;
  let bytes = 0;
  let opened = 0;
  const unopened = [];
  const search = (buffer, where) => {
    for (const [name, token] of canaries) {
      if (buffer.includes(token)) hits.set(name, [...(hits.get(name) ?? []), where]);
    }
  };
  const next = join(work, '.next');
  for (const entry of readdirSync(next, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const where = relative(work, path);
    const buffer = readFileSync(path);
    files += 1;
    bytes += buffer.length;
    search(buffer, where);
    const gzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
    const zstd = buffer.length >= 4 && buffer.readUInt32LE(0) === 0xfd2fb528;
    if (gzip || zstd) {
      try {
        search(gzip ? gunzipSync(buffer) : zstdDecompressSync(buffer), `${where} (decompressed)`);
        opened += 1;
      } catch {
        unopened.push(where);
      }
    }
  }
  for (const [name, token] of canaries) {
    if (log.includes(token)) hits.set(name, [...(hits.get(name) ?? []), '(build output)']);
  }

  console.log(`searched ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB under .next, plus the build output`);
  console.log(`compressed files opened and searched: ${opened}; could not open: ${unopened.length}`);
  for (const where of unopened.slice(0, 10)) console.log(`  not searched inside: ${where}`);

  if (hits.size === 0) {
    console.log(`no canary value found (${canaries.size} names).`);
  } else {
    for (const [name, wheres] of hits) {
      console.log(`FOUND ${name} in ${wheres.length} place(s):`);
      for (const where of wheres.slice(0, 10)) console.log(`  ${where}`);
    }
  }

  if (selfTest) {
    const seen = hits.has('SESSION_SECRET');
    console.log(seen ? 'SELF-TEST PASSED: the search finds a value the build was made to keep.' : 'SELF-TEST FAILED: a value the build was made to keep was not found.');
    return seen ? 0 : 1;
  }
  console.log(hits.size === 0 ? 'CANARY PASSED' : 'CANARY FAILED');
  return hits.size === 0 ? 0 : 1;
}

const work = mkdtempSync(join(tmpdir(), 'enginora-canary-'));
const cleanup = () => {
  if (keep) console.log(`kept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
};
// Interrupted, the copy still goes: without a handler Node dies on the signal
// and `finally` never runs. Only SIGKILL can leave it behind — random values,
// a secret of nothing, under the system's temporary directory.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}
let exitCode = 2;
try {
  exitCode = run(work);
} finally {
  cleanup();
}
process.exit(exitCode);
