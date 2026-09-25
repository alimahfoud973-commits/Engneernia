/**
 * Generates a large synthetic catalogue to measure search under the load
 * specification §30 describes ("hundreds or thousands of products").
 *
 *   node --experimental-strip-types scripts/seed-scale.ts 5000
 *   node --experimental-strip-types scripts/seed-scale.ts --remove
 *
 * Every row is slugged `scale-` so the set is trivially identifiable and
 * removable. Never run against production.
 */
import postgres from 'postgres';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* CI provides the environment */
}

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
await sql`SELECT set_config('app.actor_role', 'OWNER', false)`;

const remove = process.argv.includes('--remove');
const count = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 5000);

const SUBJECTS = [
  'تصميم الشبكات الكهربائية', 'حساب الأحمال الحرارية', 'تسليح الأساسات',
  'مخططات الواجهات المعمارية', 'شبكات مكافحة الحريق', 'تحليل المنشآت المعدنية',
  'أنظمة الطاقة الشمسية', 'التمديدات الصحية', 'حصر كميات الخرسانة',
  'تفاصيل العزل المائي', 'مواصفات الطرق', 'نمذجة BIM للمشاريع',
];
const QUALIFIERS = ['دليل عملي', 'مرجع شامل', 'جدول حسابات', 'مجموعة مخططات', 'شرح تفصيلي', 'قالب جاهز'];
const FILE_TYPES = ['PDF', 'EXCEL', 'CAD', 'REVIT_BIM', 'ARCHIVE', 'TEMPLATE', 'PROJECT'];
const LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'];
const SOFTWARE = [['AutoCAD'], ['Revit 2024'], ['ETAP'], ['Microsoft Excel'], ['SAP2000'], []];

try {
  if (remove) {
    const result = await sql`DELETE FROM products WHERE slug LIKE 'scale-%'`;
    console.log(`Removed ${result.count} synthetic products.`);
  } else {
    const disciplines = await sql<Array<{ id: string }>>`SELECT id FROM disciplines ORDER BY sort_order`;
    const categories = await sql<Array<{ id: string; discipline_id: string }>>`
      SELECT id, discipline_id FROM categories
    `;
    const [contributor] = await sql<Array<{ id: string }>>`
      SELECT id FROM contributors ORDER BY created_at LIMIT 1
    `;
    if (disciplines.length === 0 || !contributor) {
      throw new Error('Run seed:catalog and seed:demo first.');
    }

    // Every synthetic product is published and most are paid, so their
    // engineer needs terms in force in USD or none of them could be sold (F2).
    // Opened only if the engineer has none, so existing terms are never moved.
    await sql`
      INSERT INTO commission_agreements (contributor_id, model, engineer_bp, currency, note)
      SELECT ${contributor.id}, 'PERCENTAGE', 8000, 'USD', 'scale seed'
       WHERE NOT EXISTS (
         SELECT 1 FROM commission_agreements
          WHERE contributor_id = ${contributor.id} AND product_id IS NULL AND effective_to IS NULL
       )
    `;

    console.log(`Generating ${count} products...`);
    const started = Date.now();
    const BATCH = 500;

    for (let offset = 0; offset < count; offset += BATCH) {
      const rows = [];
      for (let i = offset; i < Math.min(offset + BATCH, count); i += 1) {
        const discipline = disciplines[i % disciplines.length]!;
        const pool = categories.filter((c) => c.discipline_id === discipline.id);
        const category = pool[i % Math.max(1, pool.length)];
        const isFree = i % 11 === 0;
        rows.push({
          slug: `scale-${i}`,
          title_ar: `${SUBJECTS[i % SUBJECTS.length]} — ${QUALIFIERS[i % QUALIFIERS.length]} ${i}`,
          subtitle_ar: `${QUALIFIERS[(i + 2) % QUALIFIERS.length]} يغطي الجوانب العملية والتطبيقية`,
          description_ar: `مرجع هندسي يشرح ${SUBJECTS[i % SUBJECTS.length]} بأمثلة محلولة خطوة بخطوة، ويغطي الحسابات والمعايير والتطبيق الميداني.`,
          discipline_id: discipline.id,
          category_id: category?.id ?? null,
          file_type: FILE_TYPES[i % FILE_TYPES.length]!,
          level: LEVELS[i % LEVELS.length]!,
          software_tags: SOFTWARE[i % SOFTWARE.length]!,
          is_free: isFree,
          price_minor: isFree ? 0 : 500 + (i % 40) * 125,
          sales_count: i % 37,
        });
      }

      await sql`
        INSERT INTO products ${sql(
          rows.map((r) => ({
            slug: r.slug, title_ar: r.title_ar, subtitle_ar: r.subtitle_ar,
            description_ar: r.description_ar, discipline_id: r.discipline_id,
            category_id: r.category_id, file_type: r.file_type, level: r.level,
            software_tags: r.software_tags, is_free: r.is_free, language: 'ar',
            status: 'PUBLISHED', currency: 'USD', sales_count: r.sales_count,
            published_at: new Date(Date.now() - r.sales_count * 86_400_000),
          })),
          'slug', 'title_ar', 'subtitle_ar', 'description_ar', 'discipline_id',
          'category_id', 'file_type', 'level', 'software_tags', 'is_free',
          'language', 'status', 'currency', 'sales_count', 'published_at',
        )}
        ON CONFLICT (slug) DO NOTHING
      `;

      await sql`
        INSERT INTO product_prices (product_id, amount_minor, currency)
        SELECT p.id, ${sql.unsafe('(regexp_replace(p.slug, \'scale-\', \'\')::int % 40) * 125 + 500')}, 'USD'
          FROM products p
         WHERE p.slug = ANY(${rows.map((r) => r.slug)})
           AND NOT EXISTS (SELECT 1 FROM product_prices pp
                            WHERE pp.product_id = p.id AND pp.effective_to IS NULL)
      `;

      await sql`
        INSERT INTO product_contributors (product_id, contributor_id, share_bp)
        SELECT p.id, ${contributor.id}, 10000 FROM products p
         WHERE p.slug = ANY(${rows.map((r) => r.slug)})
        ON CONFLICT (product_id, contributor_id) DO NOTHING
      `;

      process.stdout.write(`  ${Math.min(offset + BATCH, count)}/${count}\r`);
    }

    await sql`ANALYZE products`;
    console.log(`\nSeeded in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  }
} catch (error) {
  console.error(`\nScale seeding failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 10 });
}
