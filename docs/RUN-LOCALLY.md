# تشغيل إنجينورا على حاسوبك، وفتحه من هاتفك

هذا هو **الخيار الأول** من تقرير المعاينة: لا استضافة، ولا نطاق، ولا خدمة
خارجية، ولا اشتراك. المشروع يعمل على حاسوبك، وهاتفك يفتحه عبر شبكة الواي فاي
نفسها.

الخطوات مكتوبة بعد **تنفيذها فعلاً** والتحقّق من كل واحدة. وما لا يعمل مذكور في
§٦ بصراحة.

---

## ١. ما تحتاجه مثبَّتاً

| البرنامج | لماذا | التحقّق |
|---|---|---|
| **Node.js 22 أو أحدث** | تشغيل المشروع | `node -v` |
| **Docker Desktop** | قاعدة البيانات (الأسهل) | `docker -v` |
| **Git** | جلب الكود | `git -v` |

بديل Docker: PostgreSQL 16 مثبَّتاً مباشرةً. عندها تُنشئ أنت قاعدة البيانات
والأدوار التي ينشئها ملف `docker/postgres/init`.

---

## ٢. جلب المشروع وتثبيت الحزم

```bash
git clone <رابط المستودع> Engneernia
cd Engneernia
npm install
```

---

## ٣. قاعدة البيانات

```bash
docker compose up -d postgres
```

هذا يكفي. الحاوية تُنشئ قاعدة `engineering_marketplace` والأدوار `app_user`
و`migrator` بالكلمات نفسها الموجودة في `.env.example`، فلا شيء لتعدّله.

> **خدمة التخزين ليست مطلوبة.** الملفات تُخزَّن على قرصك مباشرةً في المرحلة التجريبية
> (انظر الخطوة التالية). `docker compose up -d` بلا اسم خدمة يشغّل أيضاً خدمة تخزين
> متوافقة مع S3 (RustFS) وينشئ لها الـ bucketين، وهي غير ضرورية الآن. لاستعمالها بدل
> القرص ضع `STORAGE_ENDPOINT=http://localhost:9000` في `.env.local`، والمفاتيح وأسماء
> الـ buckets في `.env.example` تعمل معها كما هي.

---

## ٤. ملف الإعدادات `.env.local`

```bash
cp .env.example .env.local
```

ثم **غيّر ثلاثة أسطر فقط**:

### أ) المفتاحان السرّيان

القيمة الافتراضية `replace-me-…` **يرفضها التطبيق عند الإقلاع عمداً**، حتى لا
يعمل أحد بمفتاح معروف. ولّد مفتاحين:

```bash
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('CONFIG_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```

والصق كل سطر مكان نظيره في `.env.local`.

### ب) مجلّد التخزين

السطر الافتراضي يشير إلى مسار على جهاز آخر. اجعله مساراً **مطلقاً** داخل
مجلّد المشروع على حاسوبك:

```bash
# macOS / Linux
STORAGE_ENDPOINT=file:///Users/<اسمك>/Engneernia/.data/storage

# Windows
STORAGE_ENDPOINT=file:///C:/Users/<اسمك>/Engneernia/.data/storage
```

المجلّد يُنشأ وحده عند أول رفع ملف؛ لا تُنشئه يدوياً.

---

## ٥. تجهيز البيانات والتشغيل

```bash
npm run db:migrate          # تطبيق كل الترحيلات
npm run bootstrap:owner     # حساب المالك — مرة واحدة فقط، يسألك عن اسم المستخدم وكلمة المرور
npm run dev                 # الخادم على http://localhost:3000
```

افتح `http://localhost:3000` على الحاسوب. إن ظهرت الصفحة الرئيسية بالعربية،
فكل شيء يعمل.

> **حسابات تجربة جاهزة** (مالك، ومهندس، وزبون):
> ```bash
> npm run preview:accounts
> ```
> يطبع اسم مستخدم المالك وكلمة مروره (يدخل من `/login/owner`)، وهاتف وبريد المهندس
> والزبون (يدخلان من `/login` بالاثنين معاً، بلا كلمة مرور — Stage 6). الأمر **يعيد ضبط**
> كلمة مرور المالك في كل تشغيل، فلا تشغّله بعد أن تعتمد كلمة مرورك الحقيقية.

---

## ٦. فتح الموقع من هاتفك

الهاتف والحاسوب على **شبكة الواي فاي نفسها**.

### الخطوة ١ — اعرف عنوان حاسوبك على الشبكة

```bash
# macOS
ipconfig getifaddr en0

# Linux
hostname -I | awk '{print $1}'

# Windows (PowerShell)
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' }).IPAddress
```

ستحصل على شيء مثل `192.168.1.12`.

### الخطوة ٢ — شغّل الخادم على كل الواجهات

```bash
npm run dev -- -H 0.0.0.0
```

بلا `-H 0.0.0.0` يستمع الخادم على `localhost` وحده، ولا يصله الهاتف إطلاقاً.

> Next يطبع `Network: http://0.0.0.0:3000`. هذا **عنوان الاستماع لا عنوان
> الزيارة** — استعمل العنوان الذي حصلت عليه في الخطوة ١.

### الخطوة ٣ — حدّث `APP_URL`

في `.env.local`:

```bash
APP_URL=http://192.168.1.12:3000
```

ثم أعد تشغيل الخادم. هذا يجعل الروابط المطلقة (في الفواتير والكشوف والرسائل)
تشير إلى العنوان الذي يراه الهاتف.

### الخطوة ٤ — افتح من الهاتف

```
http://192.168.1.12:3000
```

**ما جُرِّب على عرض ٣٩٠ بكسل ونجح:** الصفحة الرئيسية، تسجيل الدخول، **العامل
الثاني**، لوحة المالك كلها (المهندسون، الكتالوج، التسوية)، شاشة أرباح المهندس،
و**إجراءات الخادم** (إضافة مهندس، مع ظهور رسالة الرفض الصحيحة). ولا صفحة تنزلق
أفقياً.

### إن لم تفتح الصفحة

| العرض | السبب الغالب | الحل |
|---|---|---|
| «تعذّر الوصول إلى الموقع» | جدار الحماية يمنع المنفذ ٣٠٠٠ | اسمح لـNode بالاتصالات الواردة. macOS يسأل أول مرة — اضغط «سماح». |
| الصفحة تُحمَّل ثم لا يعمل أي زر | شبكتان مختلفتان (الهاتف على 5GHz والحاسوب سلكي، أو شبكة الضيوف) | ضعهما على الشبكة نفسها |
| العنوان لا يستجيب أصلاً | نسيت `-H 0.0.0.0` | أعد التشغيل بالراية |

### ما لا يعمل، وهو مقصود ذكره

**التحديث التلقائي عند تعديل الكود لا يعمل من الهاتف.** ستقرأ في وحدة تحكّم
المتصفح `WebSocket … 403`. هذا حارس في Next نفسه على قناة إعادة التحميل، وقناة
إعادة التحميل وحدها — **الصفحات والنماذج وكل شيء آخر يعمل**. بعد تعديل الكود،
حدّث الصفحة على الهاتف يدوياً.

> **لا تعرّض هذا على الإنترنت.** خادم التطوير غير مهيّأ لذلك: لا HTTPS، ولا
> بريد حقيقي، والمفاتيح محلية. الشبكة المنزلية حدّه.

---

## ٧. عيبٌ كان يمنع هذا كلّه، وأُصلح

قبل هذا العمل كانت الخطوات أعلاه تعطي **صفحة تُرسم ولا تعمل**: تظهر كاملة،
ولا يفعل أي زر شيئاً، ولا يصل الخادم أي طلب.

السبب: ترويسة `Content-Security-Policy` كانت تحمل `upgrade-insecure-requests`
في كل البيئات. المتصفح يعفي `localhost` من هذه التعليمة، **ولا يعفي أي عنوان
آخر** — فعلى `http://192.168.1.12:3000` كان يُعيد طلب كل ملف JavaScript وكل
خط وكل ورقة أنماط عبر `https`، وخادم التطوير لا يتكلّم TLS، فتموت الطلبات
كلّها بـ`ERR_CONNECTION_RESET`، ولا يُقلع React، فتبقى الصفحة صورةً ميتة.

الإصلاح: التعليمة صارت **للإنتاج وحده**. لا يحرسها منطق، بل اختبار يفشل إن
عادت إلى التطوير — لأن كل فحص آلي في هذا المستودع يخاطب `localhost`، ولا يستطيع
أيٌّ منها رؤية هذا العيب. كُشف بفتح الموقع من جهاز ثانٍ، وهو الطريق الوحيد إليه.

---

## ٨. أوامر بعد ذلك

```bash
npm run verify              # أنواع + lint + اختبارات + بناء
npm run test:integration    # اختبارات على قاعدة حقيقية — تكتب فيها بيانات اختبار؛ للعزل انظر §١٠
npm run db:prove-rls        # إثبات عزل الصلاحيات
```

---

## ٩. Windows — ما يختلف

ما يلي مُلاحَظ على لابتوب Windows (2026-10-04): Node 24، وnpm 11، وDocker Desktop.

### `npm.cmd` بدل `npm` في PowerShell

سياسة تنفيذ السكربتات في PowerShell قد تمنع `npm.ps1`، فيفشل `npm` قبل أن يبدأ.
`npm.cmd` هو البرنامج نفسه بلا ذلك الغلاف:

```powershell
npm.cmd ci
npm.cmd run dev -- --webpack
```

### `next dev` يفشل بـ`failed to create junction point`

**العرض:** `npm.cmd run dev` (Turbopack، الافتراضي في Next 16) يفشل وهو ينشئ رابطاً داخل
`.next\dev\node_modules`.

**السبب المرجّح:** في التطوير ينشئ Turbopack روابط (junctions) للحِزم المعلنة في
`serverExternalPackages` — هنا `@napi-rs/canvas` و`mupdf`. إنشاء هذه الروابط يفشل عادةً حين
يكون المشروع داخل مجلد يزامنه OneDrive (سطح المكتب والمستندات كثيراً ما يكونان كذلك)، أو على
قرص ليس NTFS. للتحقق، قراءة فقط:

```powershell
(Get-Location).Path                        # هل المسار تحت مجلد OneDrive؟
$env:OneDrive                              # مسار OneDrive إن كان مفعّلاً
(Get-Volume -DriveLetter C).FileSystemType # المتوقع: NTFS
```

**الحل البديل الذي يعمل:**

```powershell
npm.cmd run dev -- --webpack
```

الصفحات والنماذج تعمل به كما هي؛ الفرق محصور في محرّك التطوير.

**ليست مشكلة إنتاج:** `npm run build` (Turbopack أيضاً) نجح على الجهاز نفسه، والإنتاج يعمل
على Linux داخل الحاوية. لا يُعدَّل `next.config.ts` لأجلها.

**إن كان المشروع تحت OneDrive:** انقله إلى مسار غير مُزامَن مثل `C:\dev\Enginora`. المزامنة
تعمل على آلاف الملفات في `node_modules` و`.next` أثناء البناء، وهي سبب معروف لأقفال ملفات
وأخطاء متقطعة غير هذه أيضاً.

### `npm run dev` يعدّل `CLAUDE.md`

Next 16.3 يضيف عند تشغيل `next dev` كتلة تبدأ بـ`<!-- BEGIN:nextjs-agent-rules -->` إلى آخر
`CLAUDE.md` (المصدر: `node_modules/next/dist/server/lib/generate-agent-files.js`). إن ظهر
`M CLAUDE.md` في `git status` بعد التشغيل فهذا مصدره. **لا تلتزمه** — `CLAUDE.md` يُعدَّل
بقرار المالك وحده؛ احذف الكتلة يدوياً قبل أي commit.

---

## ١٠. اختبارات التكامل محلياً — دون لمس قاعدة التطوير

`npm run test:integration` يكتب بيانات اختبار في القاعدة التي يشير إليها `DATABASE_URL`. فلا
تشغّله على `engineering_marketplace` التي تعمل عليها. الطريقة أدناه تحاكي CI: **خادم PostgreSQL
منفصل** في حاوية مؤقتة على المنفذ `5433` — لا قاعدة ثانية على الخادم نفسه، لأن
`docker/postgres/init/01-roles.sql` يسمّي `engineering_marketplace` حرفياً — والتخزين في مجلد
مؤقت، فلا تُلمس RustFS ولا الـbuckets.

المتغيّرات المضبوطة في الجلسة **تغلب** `.env.local` (يُقرأ بـ`process.loadEnvFile` الذي لا يكتب
فوق متغيّر موجود)، والمفاتيح السرّية تبقى من `.env.local`.

```powershell
# 1. خادم معزول؛ يُنشئ الأدوار من 01-roles.sql كما في docker-compose
docker run -d --name em_pg_itest -p 5433:5432 `
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=engineering_marketplace `
  -v "$($PWD.Path)\docker\postgres\init:/docker-entrypoint-initdb.d:ro" postgres:16-alpine
do { Start-Sleep 2 } until ((docker logs em_pg_itest 2>&1 | Out-String) -match 'init process complete')
Start-Sleep 3

# 2. إثبات أساس RLS — قبل الترحيلات، كما في CI
docker cp src\db\security\rls-foundation.test.sql em_pg_itest:/tmp/rls-foundation.sql
docker exec em_pg_itest psql -U postgres -d engineering_marketplace -v ON_ERROR_STOP=1 -f /tmp/rls-foundation.sql

# 3. متغيّرات هذه النافذة وحدها
$env:DATABASE_URL           = "postgresql://app_user:app_password@localhost:5433/engineering_marketplace"
$env:DATABASE_MIGRATION_URL = "postgresql://migrator:migrator_password@localhost:5433/engineering_marketplace"
$env:DATABASE_SUPERUSER_URL = "postgresql://postgres:postgres@localhost:5433/engineering_marketplace"
$env:STORAGE_ENDPOINT       = "file:///" + (Join-Path $env:TEMP 'enginora-itest').Replace('\', '/')
$env:LOG_LEVEL              = "info"

# 4. الترحيلات والبذور الثلاث والاختبارات — بترتيب CI
npm.cmd run db:migrate
npm.cmd run seed:catalog; npm.cmd run seed:demo; npm.cmd run seed:scale
npm.cmd run test:integration

# 5. التنظيف: الحاوية المؤقتة وحدها، ثم أغلق النافذة لتزول المتغيّرات
docker rm -f -v em_pg_itest
```

المتوقع: 67 ترحيلاً، و`Test Files 41 passed`، و`Tests 723 passed`. الإجراء نفسه بمكافئه على Linux
أعطى ذلك في 2026-10-04.

لا تُشغّل الخطوة 5 على اسم غير `em_pg_itest`: `em_postgres` و`em_storage` هما قاعدة التطوير
وتخزينه.
