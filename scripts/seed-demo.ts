/**
 * DEMONSTRATION DATA ONLY.
 *
 * Creates one sample contributor and a handful of published products so the
 * storefront can be reviewed before real content exists. Every row it writes
 * is prefixed `demo-`, so it is trivially identifiable and removable.
 *
 *   node --experimental-strip-types scripts/seed-demo.ts
 *   node --experimental-strip-types scripts/seed-demo.ts --remove
 *
 * Never run this against production.
 */
import postgres from 'postgres';
import { hash as argonHash } from '@node-rs/argon2';

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

/**
 * Seeding acts AS THE PLATFORM OWNER.
 *
 * Tables carrying private commercial data (product_contributors, prices) use
 * FORCE ROW LEVEL SECURITY, which applies even to the role that owns them —
 * so a script with no actor context is refused, exactly as intended. Declaring
 * owner context here is the honest way to say what this script is doing,
 * rather than weakening a policy to make a convenience script work.
 */
await sql`SELECT set_config('app.actor_role', 'OWNER', false)`;
const remove = process.argv.includes('--remove');

interface ProductSeed {
  slug: string;
  titleAr: string;
  subtitleAr: string;
  descriptionAr: string;
  discipline: string;
  category: string;
  fileType: string;
  level: string;
  software: string[];
  priceMinor: number;
}

const PRODUCTS: readonly ProductSeed[] = [
  {
    slug: 'demo-load-calculation-sheet',
    titleAr: 'جدول حساب الأحمال الكهربائية',
    subtitleAr: 'ملف Excel جاهز لحساب أحمال المباني السكنية والتجارية',
    descriptionAr:
      'جدول حسابات متكامل يغطي تقدير الأحمال، معامل التزامن، اختيار القواطع ومقاطع الكابلات، مع أمثلة محلولة لمبنى سكني من ستة طوابق.',
    discipline: 'electrical', category: 'excel-sheets',
    fileType: 'EXCEL', level: 'INTERMEDIATE', software: ['Microsoft Excel'], priceMinor: 1500,
  },
  {
    slug: 'demo-solar-design-guide',
    titleAr: 'دليل تصميم أنظمة الطاقة الشمسية',
    subtitleAr: 'من حساب الأحمال حتى اختيار الإنفرتر والبطاريات',
    descriptionAr:
      'دليل عملي لتصميم أنظمة الطاقة الشمسية المستقلة والمربوطة بالشبكة، يشرح حساب الاستطاعة، زوايا الميل، حجم البطاريات، وحماية النظام.',
    discipline: 'electrical', category: 'solar-renewable',
    fileType: 'PDF', level: 'BEGINNER', software: [], priceMinor: 0,
  },
  {
    slug: 'demo-rc-beam-design',
    titleAr: 'تصميم الجوائز الخرسانية المسلحة',
    subtitleAr: 'شرح تفصيلي مع أمثلة محلولة وفق الكود الأمريكي ACI',
    descriptionAr:
      'مرجع يشرح تصميم الجوائز المستطيلة وذات الشكل T، حساب التسليح الطولي والعرضي، تدقيق القص والانحراف، مع تمارين محلولة خطوة بخطوة.',
    discipline: 'civil', category: 'reinforced-concrete',
    fileType: 'PDF', level: 'ADVANCED', software: ['ETABS', 'SAFE'], priceMinor: 2500,
  },
  {
    slug: 'demo-quantity-survey-template',
    titleAr: 'قالب حصر الكميات وتقدير التكاليف',
    subtitleAr: 'نموذج Excel لمشاريع الأبنية',
    descriptionAr:
      'قالب جاهز لحصر كميات الأعمال الترابية والخرسانية وأعمال التشطيب، مع ربط تلقائي بجدول الأسعار وملخص تكلفة المشروع.',
    discipline: 'civil', category: 'quantity-surveying',
    fileType: 'EXCEL', level: 'INTERMEDIATE', software: ['Microsoft Excel'], priceMinor: 2000,
  },
  {
    slug: 'demo-revit-family-pack',
    titleAr: 'حزمة عائلات ريفيت معمارية',
    subtitleAr: 'أبواب ونوافذ وعناصر تشطيب جاهزة للاستخدام',
    descriptionAr:
      'مجموعة عائلات ريفيت معمارية مُعدّة بمعايير قياسية وقابلة للتعديل البارامتري، تغطي الأبواب والنوافذ والدرابزين وعناصر الواجهات.',
    discipline: 'architecture', category: 'bim-libraries',
    fileType: 'REVIT_BIM', level: 'INTERMEDIATE', software: ['Revit 2024'], priceMinor: 3000,
  },
  {
    slug: 'demo-architectural-details',
    titleAr: 'مجموعة التفاصيل المعمارية التنفيذية',
    subtitleAr: 'ملفات أوتوكاد جاهزة للتفاصيل الشائعة',
    descriptionAr:
      'أكثر من مئة تفصيل تنفيذي بصيغة DWG تشمل العزل المائي والحراري، تفاصيل الأسقف والأرضيات، ووصلات الواجهات.',
    discipline: 'architecture', category: 'architectural-details',
    fileType: 'CAD', level: 'INTERMEDIATE', software: ['AutoCAD'], priceMinor: 2200,
  },
  {
    slug: 'demo-hvac-load-estimation',
    titleAr: 'حساب أحمال التكييف',
    subtitleAr: 'منهجية عملية مع جدول حسابات',
    descriptionAr:
      'شرح منهجية حساب أحمال التبريد والتدفئة للمباني، يشمل الأحمال الخارجية والداخلية والتهوية، مع جدول حسابات جاهز للتطبيق.',
    discipline: 'mechanical', category: 'hvac',
    fileType: 'EXCEL', level: 'INTERMEDIATE', software: ['Microsoft Excel'], priceMinor: 1800,
  },
  {
    slug: 'demo-fire-fighting-basics',
    titleAr: 'أساسيات تصميم أنظمة مكافحة الحريق',
    subtitleAr: 'مرجع تمهيدي وفق NFPA',
    descriptionAr:
      'مقدمة لتصميم شبكات المرشات ومآخذ الحريق، تشمل تصنيف المخاطر، حساب التدفق والضغط، واختيار المضخات.',
    discipline: 'mechanical', category: 'fire-fighting',
    fileType: 'PDF', level: 'BEGINNER', software: [], priceMinor: 0,
  },
];

try {
  if (remove) {
    await sql`DELETE FROM products WHERE slug LIKE 'demo-%'`;
    await sql`DELETE FROM contributors WHERE public_slug LIKE 'demo-%'`;
    await sql`DELETE FROM users WHERE email LIKE 'demo-%@example.com'`;
    console.log('Demonstration data removed.');
  } else {
    const passwordHash = await argonHash('demo-account-not-for-production', {
      algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });

    const [user] = await sql<Array<{ id: string }>>`
      INSERT INTO users (email, password_hash, role, status, display_name, email_verified_at)
      VALUES ('demo-engineer@example.com', ${passwordHash}, 'CONTRIBUTOR', 'ACTIVE',
              'م. عرض توضيحي', now())
      ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
      RETURNING id
    `;

    const [contributor] = await sql<Array<{ id: string }>>`
      INSERT INTO contributors (user_id, public_slug, settlement_code, display_name,
                                specialization, bio, is_active, can_submit_drafts, approved_at)
      VALUES (${user!.id}, 'demo-engineer', 'DEMO', 'م. عرض توضيحي',
              'محتوى تجريبي لمعاينة المنصة',
              'حساب توضيحي أُنشئ لعرض واجهة المنصة قبل إضافة المحتوى الحقيقي.',
              true, false, now())
      ON CONFLICT (public_slug) DO UPDATE SET display_name = EXCLUDED.display_name
      RETURNING id
    `;

    for (const product of PRODUCTS) {
      const [row] = await sql<Array<{ id: string }>>`
        INSERT INTO products (slug, title_ar, subtitle_ar, description_ar, discipline_id,
                              category_id, file_type, language, level, software_tags,
                              status, currency, is_free, published_at)
        VALUES (
          ${product.slug}, ${product.titleAr}, ${product.subtitleAr}, ${product.descriptionAr},
          (SELECT id FROM disciplines WHERE slug = ${product.discipline}),
          (SELECT c.id FROM categories c JOIN disciplines d ON d.id = c.discipline_id
            WHERE c.slug = ${product.category} AND d.slug = ${product.discipline}),
          ${product.fileType}::file_type, 'ar', ${product.level}::product_level,
          ${product.software}, 'PUBLISHED'::product_status, 'USD',
          ${product.priceMinor === 0}, now()
        )
        ON CONFLICT (slug) DO UPDATE SET title_ar = EXCLUDED.title_ar, updated_at = now()
        RETURNING id
      `;

      await sql`
        INSERT INTO product_contributors (product_id, contributor_id, share_bp)
        VALUES (${row!.id}, ${contributor!.id}, 10000)
        ON CONFLICT (product_id, contributor_id) DO NOTHING
      `;

      // Only open a price row if none exists, so re-running never disturbs a
      // price the owner has since changed.
      await sql`
        INSERT INTO product_prices (product_id, amount_minor, currency, reason)
        SELECT ${row!.id}, ${product.priceMinor}::bigint, 'USD', 'demonstration seed'
         WHERE NOT EXISTS (
           SELECT 1 FROM product_prices
            WHERE product_id = ${row!.id} AND effective_to IS NULL
         )
      `;
    }

    console.log(`Seeded 1 demonstration contributor and ${PRODUCTS.length} published products.`);
    console.log('Remove with:  node --experimental-strip-types scripts/seed-demo.ts --remove');
  }
} catch (error) {
  console.error(`Demo seeding failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
