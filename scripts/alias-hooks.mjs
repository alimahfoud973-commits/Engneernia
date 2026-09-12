import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

/**
 * Makes plain Node resolve the project's TypeScript import style.
 *
 * Next and Vitest handle two things Node does not: the "@/..." path alias,
 * and extensionless imports that point at a file or a directory index. A
 * maintenance script that imports application code — a seed, a backfill, a
 * settlement run — needs both, so this hook supplies them and nothing else.
 */
const SRC = resolvePath(process.cwd(), 'src');

const CANDIDATES = (base) => [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];

async function tryCandidates(base, context, nextResolve) {
  for (const candidate of CANDIDATES(base)) {
    try {
      return await nextResolve(pathToFileURL(candidate).href, context);
    } catch {
      // try the next shape
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const found = await tryCandidates(resolvePath(SRC, specifier.slice(2)), context, nextResolve);
    if (found) return found;
  }

  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
    const found = await tryCandidates(base, context, nextResolve);
    if (found) return found;
  }

  return nextResolve(specifier, context);
}
