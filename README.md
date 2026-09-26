# منصة الموارد الهندسية — Engineering Marketplace

منصة رقمية للمعرفة والموارد الهندسية في أربعة تخصصات: الكهربائية، الميكانيكية،
المعمارية، والمدنية. النشر بيد مالك المنصة، والعمولة ديناميكية لكل مهندس ومنتج،
والتسوية مع المهندسين شهرية.

## المتطلبات

- Node.js 22+
- PostgreSQL 16 (أو `docker compose up -d`)
- تخزين متوافق مع S3 (RustFS محلياً عبر `docker compose`)، أو ملفات على القرص بـ `file://`

## التشغيل

```bash
cp .env.example .env.local     # ثم املأ القيم
docker compose up -d           # PostgreSQL + تخزين S3 (RustFS)
npm ci
npm run dev
```

الفحص الكامل قبل أي commit:

```bash
npm run verify              # أنواع + lint + اختبارات الوحدة + بناء
npm run test:integration    # على قاعدة بيانات حقيقية
npm run db:prove-rls        # إثبات أن دور التطبيق لا يتجاوز سياسات الصفوف
```

وعلى بناء إنتاجي يعمل:

```bash
node scripts/security-probe.mjs   # ٤٨ فحصاً أمنياً من خارج التطبيق
node scripts/csp-check.mjs        # سياسة المحتوى لا تكسر الموقع
node scripts/measure-pages.mjs    # زمن كل صفحة وعدد استعلاماتها
npm run backup && npm run restore-drill
```

## البنية

```
src/
├── app/              واجهة Next.js (App Router، عربية RTL)
├── db/               اتصال قاعدة البيانات والمخطط
│   └── security/     إثبات عزل الصلاحيات على قاعدة حقيقية
├── i18n/             التعريب — العربية أساسية، الإنجليزية قابلة للإضافة
└── lib/
    ├── money/        النواة المالية: العملات، العمولة، التوزيع
    ├── time/         الفترات المحاسبية (Asia/Damascus)
    ├── config/       بيئة مُتحقق منها عند الإقلاع
    └── errors.ts     تصنيف أخطاء النطاق
```

## التوثيق

| الملف | المحتوى |
|---|---|
| `CLAUDE.md` | القواعد غير القابلة للتفاوض |
| `docs/DECISIONS.md` | سجل القرارات المعتمدة والمعلّقة |
| `docs/ROADMAP.md` | المراحل ومعايير الخروج |
| `docs/PROJECT_SPECIFICATION.md` | المواصفات الأساسية |
| `docs/ADDITIONAL_DECISIONS.md` | قرارات المالك المكمّلة |
| `docs/DEPLOYMENT.md` | **النشر وقائمة ما قبل الإطلاق وأدلة التشغيل** |
| `docs/SECURITY-REVIEW.md` | المراجعة الأمنية والقائمة المرجعية (تنتظر اعتماد المالك) |
| `docs/BACKUP-AND-RESTORE.md` | النسخ الاحتياطي وتمرين الاستعادة |
| `docs/PERFORMANCE.md` | القياسات على ٥٬٠٠٩ منتج، والعتبات |
| `docs/SEO.md` | الفهرسة والبيانات الوصفية |
| `docs/KNOWN-ISSUES.md` | مسائل معروفة وما يجب تعلّمه منها |

## ملاحظة أمنية

المستودع **خاص**. لا تُرفع أسرار حقيقية إلى الشيفرة — كل قيمة حساسة تمر عبر
متغيرات البيئة، وتُتحقق عند الإقلاع في `src/lib/config/env.ts`.
