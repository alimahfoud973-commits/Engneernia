/**
 * DEMONSTRATION MEDIA.
 *
 * Generates a realistic multi-page PDF, runs it through the real ingest
 * pipeline, and attaches it to a demonstration product so the storefront can
 * be reviewed with a working preview.
 *
 *   node --experimental-strip-types scripts/seed-demo-media.ts
 *
 * It uses the same code path as a real upload — validation, scanning, private
 * storage, preview derivation — rather than writing rows directly, so what is
 * reviewed is what the pipeline actually produces.
 */
import { writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* CI provides the environment */
}

const PAGES = 48;
const TARGET_SLUG = process.argv[2] ?? 'demo-solar-design-guide';

async function buildGuide(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= PAGES; page += 1) {
    const p = doc.addPage([595, 842]);
    p.drawText('Solar Energy System Design Guide', {
      x: 60, y: 780, size: 19, font, color: rgb(0.07, 0.4, 0.36),
    });
    p.drawText(`Page ${page} of ${PAGES}`, {
      x: 60, y: 752, size: 11, font, color: rgb(0.45, 0.45, 0.45),
    });
    // A per-page marker, so a leak of a withheld page would be obvious.
    p.drawText(`CONFIDENTIAL-PAGE-${page}`, { x: 60, y: 700, size: 20, font });
    for (let line = 0; line < 16; line += 1) {
      p.drawText(`${page}.${line + 1}  Array sizing, inverter selection and cable loss budget.`, {
        x: 60, y: 660 - line * 24, size: 11, font, color: rgb(0.2, 0.2, 0.2),
      });
    }
  }
  return doc.save();
}

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

try {
  const pdf = await buildGuide();
  await writeFile('/tmp/demo-guide.pdf', pdf);
  console.log(`Built a ${PAGES}-page guide (${Math.round(pdf.byteLength / 1024)} KB).`);

  await sql`SELECT set_config('app.actor_role', 'OWNER', false)`;

  const [owner] = await sql<Array<{ id: string }>>`
    SELECT id FROM users WHERE role = 'OWNER' LIMIT 1
  `;
  const [product] = await sql<Array<{ id: string }>>`
    SELECT id FROM products WHERE slug = ${TARGET_SLUG}
  `;

  if (!owner) throw new Error('No owner account. Run: npm run bootstrap:owner');
  if (!product) throw new Error(`No product with slug ${TARGET_SLUG}. Run: npm run seed:demo`);

  await sql`UPDATE products SET file_type = 'PDF' WHERE id = ${product.id}`;
  await sql.end({ timeout: 5 });

  // Import the pipeline only now: it reads the validated environment at load.
  const { ingestProductFile } = await import('../src/media/ingest.ts');
  const result = await ingestProductFile(
    {
      kind: 'USER', userId: owner.id, role: 'OWNER', displayName: 'Owner',
      locale: 'ar', sessionId: 'seed', contributorId: null,
      contributorActive: false, twoFactorSatisfied: true,
    },
    {
      productId: product.id,
      filename: 'solar-design-guide.pdf',
      declaredType: 'PDF',
      body: pdf,
      contentType: 'application/pdf',
    },
  );

  console.log('Ingested through the real pipeline:');
  console.log(`  source pages     : ${result.pageCount}`);
  console.log(`  preview pages    : ${result.previewPageCount}`);
  console.log(`  scan status      : ${result.scanStatus}`);
  console.log(`  preview file id  : ${result.previewFileId}`);
  process.exit(0);
} catch (error) {
  console.error(`Demo media seeding failed: ${(error as Error).message}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
