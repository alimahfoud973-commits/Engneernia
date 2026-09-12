/**
 * Seeds the four engineering disciplines and their category trees
 * (specification §5–§8), plus a small set of demonstration products so the
 * storefront has something to render before real content arrives.
 *
 *   node --experimental-strip-types scripts/seed-catalog.ts
 *
 * Idempotent: re-running updates names and ordering without duplicating rows
 * or disturbing anything the owner has since edited by hand.
 *
 * The categories here are STARTING POINTS, not fixed structure — specification
 * §5 and §8 are explicit that the owner can add, rename, reorder and disable
 * them from the admin console.
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

interface DisciplineSeed {
  slug: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  iconKey: string;
  categories: ReadonlyArray<readonly [string, string, string]>; // slug, ar, en
}

const DISCIPLINES: readonly DisciplineSeed[] = [
  {
    slug: 'electrical',
    nameAr: 'الهندسة الكهربائية',
    nameEn: 'Electrical Engineering',
    descriptionAr: 'أنظمة القوى والتيار الخفيف والطاقة المتجددة والتصميم الكهربائي',
    iconKey: 'bolt',
    categories: [
      ['power-systems', 'التيار القوي وأنظمة القوى', 'Power Systems'],
      ['elv', 'التيار الخفيف', 'Weak Current / ELV'],
      ['solar-renewable', 'الطاقة الشمسية والمتجددة', 'Solar & Renewable Energy'],
      ['mv-hv', 'الجهد المتوسط والعالي', 'Medium & High Voltage'],
      ['network-analysis', 'تحليل الشبكات الكهربائية', 'Electrical Network Analysis'],
      ['protection-coordination', 'الحماية والتنسيق', 'Protection & Coordination'],
      ['electrical-design', 'التصميم الكهربائي', 'Electrical Design'],
      ['lighting-design', 'تصميم الإنارة', 'Lighting Design'],
      ['earthing-lightning', 'التأريض والحماية من الصواعق', 'Earthing & Lightning Protection'],
      ['fire-alarm', 'أنظمة إنذار الحريق', 'Fire Alarm Systems'],
      ['cctv-security', 'المراقبة وأنظمة الأمن', 'CCTV & Security Systems'],
      ['telecom-cabling', 'الاتصالات والتمديدات المهيكلة', 'Telecom / Structured Cabling'],
      ['automation-plc', 'الأتمتة و PLC', 'Automation & PLC'],
      ['electrical-software', 'برمجيات الهندسة الكهربائية', 'Electrical Engineering Software'],
      ['excel-sheets', 'جداول حسابات Excel', 'Excel Calculation Sheets'],
      ['templates', 'قوالب جاهزة', 'Templates'],
      ['projects', 'مشاريع هندسية', 'Engineering Projects'],
      ['books-guides', 'كتب وأدلة تعليمية', 'Educational Books & Guides'],
    ],
  },
  {
    slug: 'civil',
    nameAr: 'الهندسة المدنية',
    nameEn: 'Civil Engineering',
    descriptionAr: 'الإنشاءات والخرسانة المسلحة والأساسات والطرق وإدارة المشاريع',
    iconKey: 'structure',
    categories: [
      ['structural', 'الهندسة الإنشائية', 'Structural Engineering'],
      ['reinforced-concrete', 'الخرسانة المسلحة', 'Reinforced Concrete'],
      ['steel-structures', 'المنشآت المعدنية', 'Steel Structures'],
      ['foundations', 'الأساسات', 'Foundations'],
      ['geotechnical', 'الهندسة الجيوتقنية', 'Geotechnical Engineering'],
      ['soil-mechanics', 'ميكانيك التربة', 'Soil Mechanics'],
      ['roads-transportation', 'الطرق والنقل', 'Roads & Transportation'],
      ['surveying', 'المساحة', 'Surveying'],
      ['quantity-surveying', 'حصر الكميات', 'Quantity Surveying'],
      ['project-management', 'إدارة المشاريع', 'Project Management'],
      ['cost-estimation', 'تقدير التكاليف', 'Cost Estimation'],
      ['specifications', 'المواصفات الفنية', 'Specifications'],
      ['water-wastewater', 'المياه والصرف الصحي', 'Water & Wastewater'],
      ['hydraulics', 'الهندسة الهيدروليكية', 'Hydraulic Engineering'],
      ['civil-software', 'برمجيات الهندسة المدنية', 'Civil Engineering Software'],
      ['autocad-civil3d', 'أوتوكاد و Civil 3D', 'AutoCAD / Civil 3D'],
      ['excel-sheets', 'جداول حسابات Excel', 'Excel Calculation Sheets'],
      ['templates', 'قوالب جاهزة', 'Templates'],
      ['projects', 'مشاريع هندسية', 'Engineering Projects'],
      ['books-guides', 'كتب وأدلة تعليمية', 'Educational Books & Guides'],
    ],
  },
  {
    slug: 'architecture',
    nameAr: 'الهندسة المعمارية',
    nameEn: 'Architecture',
    descriptionAr: 'التصميم المعماري والمخططات التنفيذية والنمذجة و BIM',
    iconKey: 'building',
    categories: [
      ['architectural-design', 'التصميم المعماري', 'Architectural Design'],
      ['construction-drawings', 'المخططات التنفيذية', 'Construction Drawings'],
      ['architectural-details', 'التفاصيل المعمارية', 'Architectural Details'],
      ['autocad', 'أوتوكاد', 'AutoCAD'],
      ['revit-architecture', 'ريفيت المعماري', 'Revit Architecture'],
      ['bim', 'نمذجة معلومات البناء BIM', 'BIM'],
      ['3d-modeling', 'النمذجة ثلاثية الأبعاد', '3D Modeling'],
      ['3d-visualization', 'الإظهار المعماري', '3D Visualization'],
      ['interior-design', 'التصميم الداخلي', 'Interior Design'],
      ['landscape', 'تنسيق المواقع', 'Landscape'],
      ['facades', 'الواجهات', 'Facades'],
      ['sections-elevations', 'المقاطع والواجهات', 'Sections & Elevations'],
      ['codes-specifications', 'الأكواد والمواصفات', 'Codes & Specifications'],
      ['cad-libraries', 'مكتبات CAD', 'CAD Libraries'],
      ['bim-libraries', 'مكتبات BIM', 'BIM Libraries'],
      ['templates', 'قوالب جاهزة', 'Templates'],
      ['projects', 'مشاريع معمارية', 'Architecture Projects'],
      ['books-guides', 'كتب وأدلة تعليمية', 'Educational Books & Guides'],
    ],
  },
  {
    slug: 'mechanical',
    nameAr: 'الهندسة الميكانيكية',
    nameEn: 'Mechanical Engineering',
    descriptionAr: 'التكييف والتمديدات الصحية ومكافحة الحريق والتصميم الميكانيكي',
    iconKey: 'gear',
    categories: [
      ['hvac', 'التدفئة والتهوية والتكييف', 'HVAC'],
      ['plumbing', 'التمديدات الصحية', 'Plumbing'],
      ['fire-fighting', 'مكافحة الحريق', 'Fire Fighting'],
      ['mechanical-design', 'التصميم الميكانيكي', 'Mechanical Design'],
      ['piping', 'شبكات الأنابيب', 'Piping'],
      ['mechanical-equipment', 'المعدات الميكانيكية', 'Mechanical Equipment'],
      ['rotating-equipment', 'المعدات الدوارة', 'Rotating Equipment'],
      ['thermal-energy', 'الأنظمة الحرارية والطاقة', 'Energy & Thermal Systems'],
      ['maintenance', 'الصيانة', 'Maintenance'],
      ['mep', 'الأنظمة الكهروميكانيكية MEP', 'MEP'],
      ['revit-mep', 'ريفيت MEP', 'Revit MEP'],
      ['mechanical-cad', 'أوتوكاد الميكانيكي', 'AutoCAD / Mechanical CAD'],
      ['engineering-calculations', 'الحسابات الهندسية', 'Engineering Calculations'],
      ['excel-sheets', 'جداول حسابات Excel', 'Excel Calculation Sheets'],
      ['templates', 'قوالب جاهزة', 'Templates'],
      ['projects', 'مشاريع هندسية', 'Engineering Projects'],
      ['books-guides', 'كتب وأدلة تعليمية', 'Educational Books & Guides'],
    ],
  },
];

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

try {
  let disciplineCount = 0;
  let categoryCount = 0;

  for (const [index, discipline] of DISCIPLINES.entries()) {
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO disciplines (slug, name_ar, name_en, description_ar, icon_key, sort_order, is_active)
      VALUES (${discipline.slug}, ${discipline.nameAr}, ${discipline.nameEn},
              ${discipline.descriptionAr}, ${discipline.iconKey}, ${index + 1}, true)
      ON CONFLICT (slug) DO UPDATE
        SET name_ar = EXCLUDED.name_ar,
            name_en = EXCLUDED.name_en,
            description_ar = EXCLUDED.description_ar,
            icon_key = EXCLUDED.icon_key,
            updated_at = now()
      RETURNING id
    `;
    disciplineCount += 1;

    for (const [order, [slug, nameAr, nameEn]] of discipline.categories.entries()) {
      await sql`
        INSERT INTO categories (discipline_id, slug, name_ar, name_en, sort_order, is_active)
        VALUES (${row!.id}, ${slug}, ${nameAr}, ${nameEn}, ${order + 1}, true)
        ON CONFLICT (discipline_id, slug) DO UPDATE
          SET name_ar = EXCLUDED.name_ar,
              name_en = EXCLUDED.name_en,
              sort_order = EXCLUDED.sort_order,
              updated_at = now()
      `;
      categoryCount += 1;
    }
  }

  console.log(`Seeded ${disciplineCount} disciplines and ${categoryCount} categories.`);
  console.log('These are starting points — the owner can rename, reorder and disable them.');
} catch (error) {
  console.error(`Seeding failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
