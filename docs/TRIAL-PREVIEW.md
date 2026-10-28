# بيئة التجربة المحلية `enginora-trial`

دورة شراء كاملة على حاسوب المالك، بالصورة الإنتاجية نفسها، وبجانب مشروعين قائمين
لا يجوز لمسهما. **لا نفق، ولا استضافة، ولا بيانات حقيقية، ولا R2، ولا SMTP، ولا
مفاتيح نسخ إنتاجية.**

| البند | الحالة |
|---|---|
| الملفات (`docker-compose.trial.yml`، `deploy/clamav/clamd.trial.conf`، هذا الملف) | مكتوبة في P1 ويحرسها `src/lib/config/trial-stack.test.ts` |
| دمج Compose (اسم المشروع، المنافذ، `restart`، أسماء وحدات التخزين والشبكات) | **مُثبت في بيئة عزل بـCompose 5.6.0 وحدها.** على الحاسوب (Compose 5.5.1) **لم يُثبت**، ويُثبته `Assert-TrialSafe` في P2 قبل أي تشغيل |
| قواعد توقيع ClamAV في الصورة | **غير مؤكَّدة**. تُفحص في P2 |
| نهايات الأسطر في `clamd.trial.conf` على الحاسوب | **عائق مفتوح**: Git for Windows يُخرج الملفات بـCRLF، وclamd يرفض CR في القيم (قراءة مصدر ClamAV 1.5.0، لا تشغيل). `Assert-TrialSafe` يرفض المتابعة عليه؛ الإصلاح المقترح (`.gitattributes`) ينتظر موافقة المالك |
| ذاكرة clamd الفعلية | **غير مقيسة**. `mem_limit: 2g` مؤقت حتى قياس P3 |
| دورة الشراء والنسخ والاستعادة | **لم تُنفَّذ** |

كل مرحلة من P2 فما بعد **تحتاج موافقة المالك الصريحة** قبل تنفيذها، وتتوقّف عند أول
نتيجة غير متوقعة.

---

## ١. الموارد المحمية

لا يُسمح لأي أمر هنا بأن يغيّرها:

- الحاويات: `em_postgres`، `em_storage`، `em_storage_init`، `enginora-preview-postgres-1`
- وحدات التخزين: `enginora-live_postgres_data`، `enginora-live_storage_data`، `enginora-preview_postgres_data`
- الشبكات: `enginora-live_default`، `enginora-preview_default`
- المنفذ `127.0.0.1:5432` (تحمله `enginora-preview-postgres-1`)
- محرك Docker بالمعرّف `32848270-4c74-4c6b-a632-88f550343be9`

**لماذا الخطر حقيقي هنا تحديداً:** مجلد المستودع على الحاسوب اسمه `Enginora-live`،
فاسم المشروع الافتراضي هو `enginora-live` — **مشروع التطوير**. وملف الإنتاج لا يحمل
`name:`، ووحدة تخزينه اسمها `postgres_data` كوحدة التطوير. فأمر Compose يذكر ملف
الإنتاج وينسى الطبقة أو `-p` يربط قاعدة الإنتاج بـ`enginora-live_postgres_data`.
أُثبت هذا بـ`config` في بيئة العزل.

ثلاثة خطوط دفاع:

1. **`-p enginora-trial` في كل أمر**، عبر الدالة `trial` وحدها (§٣). يتغلّب على
   `COMPOSE_PROJECT_NAME` وعلى `name:`.
2. **`name: enginora-trial`** في الطبقة.
3. **أسماء وحدات التخزين والشبكات مثبّتة** على `enginora-trial_*`: حتى تحت اسم مشروع
   خاطئ لا تُربط بيانات مشروع آخر. (الحاويات تبقى معرّضة، ولذلك الخط الأول.)

## ٢. البيئة

```
Windows (Chrome/Edge) ── http://127.0.0.1:3100 ──► app (الصورة الإنتاجية)
                                                    │ default         │ scanner
                                   postgres (بلا منفذ) ◄┤                 └► clamav (3310 داخلياً)
                                   storage  (بلا منفذ) ◄┘ ◄ storage-init
                                   tools (profile tools، لـ seed و bootstrap فقط)
```

- `restart: "no"` لكل خدمة: إعادة تشغيل الحاسوب أو Docker Desktop لا تُعيد التجربة.
- قيم ثابتة في الطبقة لا تُقرأ من ملف البيئة: `APP_URL=http://127.0.0.1:3100`،
  التخزين RustFS، بريد على `mail.invalid`، `SEO_INDEXABLE=false` (وrobots يمنع كل شيء).
- **المتصفح: Chrome أو Edge.** كعكة الجلسة `__Host-em_session` مع `Secure` على
  `http://127.0.0.1` جُرّبت على Chromium 141 وحده؛ Firefox لم يُجرَّب.
- **الملفات غير PDF لا تُنزَّل في هذه البيئة**: تسليمها إعادة توجيه إلى
  `http://storage:9000`، وهو اسم لا يُحلّ من Windows. الدورة على PDF فقط.
- **أغلق Chrome أو معظم ألسنته أثناء البناء وتشغيل ClamAV.** آخر قياس: ذاكرة Windows
  الحرّة 1.09 GB، وvmmem ~1722 MB، وChrome ~1788 MB؛ وآلة Docker تستطيع النمو إلى 3.77 GiB.

## ٣. دوال PowerShell (5.1)

تُلصق في **نافذة PowerShell جديدة**، من مجلد المستودع. نافذة جديدة لأن متغيّراً
باقياً من جلسة سابقة (مثل `DATABASE_URL` من المعاينة) **يتغلّب على ملف البيئة** في
Compose دون أي تحذير.

```powershell
$TrialEngineId = '32848270-4c74-4c6b-a632-88f550343be9'

# الطريق الوحيد إلى Compose في هذا الملف.
function trial {
  docker compose -p enginora-trial -f docker-compose.prod.yml -f docker-compose.trial.yml --env-file .env.trial.local @args
}

function Get-DockerNames {
  $c = @(docker ps -a --format '{{.Names}} {{.ID}} {{.State}}')
  $v = @(docker volume ls --format '{{.Name}}')
  $n = @(docker network ls --format '{{.Name}}')
  @($c + $v + $n) | Sort-Object -Unique
}

function Assert-OnlyTrialChanged($Before) {
  $diff = Compare-Object $Before (Get-DockerNames) | Where-Object { $_.InputObject -notlike 'enginora-trial*' }
  if ($diff) { $diff | Format-Table -AutoSize; throw 'STOP: changed outside enginora-trial.' }
  'OK: nothing changed outside enginora-trial.'
}

function Assert-TrialSafe {
  if ($env:COMPOSE_PROJECT_NAME) { throw 'STOP: COMPOSE_PROJECT_NAME is set in this shell.' }
  if ($env:COMPOSE_FILE) { throw 'STOP: COMPOSE_FILE is set in this shell.' }
  $keys = 'APP_URL','DATABASE_URL','DATABASE_MIGRATION_URL','POSTGRES_SUPERUSER_PASSWORD',
          'SESSION_SECRET','CONFIG_ENCRYPTION_KEY','STORAGE_ENDPOINT','STORAGE_ACCESS_KEY_ID',
          'STORAGE_SECRET_ACCESS_KEY','MAIL_TRANSPORT_URL','MAIL_FROM','SEO_INDEXABLE'
  foreach ($k in $keys) { if (Test-Path "env:$k") { throw "STOP: $k is set in this shell; open a new window." } }
  if (Test-Path .env) { throw 'STOP: a .env file exists in the checkout.' }
  if (-not (Test-Path .env.trial.local)) { throw 'STOP: .env.trial.local is missing.' }
  # clamd strips spaces, tabs and LF from each value, not CR: `TCPSocket 3310<CR>` fails its
  # format check and clamd does not start (ClamAV 1.5.0 common/optparser.c).
  if ([IO.File]::ReadAllText((Join-Path (Get-Location) 'deploy\clamav\clamd.trial.conf')).Contains("`r")) {
    throw 'STOP: deploy/clamav/clamd.trial.conf has CRLF line endings; clamd refuses them.'
  }
  $id = docker info --format '{{.ID}}'
  if ($id -ne $TrialEngineId) { throw 'STOP: not the known Docker engine.' }

  # The merged configuration, into a variable: it holds every secret and is never printed.
  $json = trial --profile tools config --format json | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'STOP: compose config failed.' }
  $cfg = $json | ConvertFrom-Json
  Remove-Variable json

  if ($cfg.name -ne 'enginora-trial') { throw "STOP: project is $($cfg.name)." }
  foreach ($s in $cfg.services.PSObject.Properties) {
    if ($s.Value.restart -ne 'no') { throw "STOP: $($s.Name) restart is $($s.Value.restart)." }
    $ports = @($s.Value.ports | Where-Object { $_ })
    if ($s.Name -eq 'app') {
      if ($ports.Count -ne 1 -or $ports[0].host_ip -ne '127.0.0.1' -or [string]$ports[0].published -ne '3100' -or $ports[0].target -ne 3000) {
        throw 'STOP: app is not published on 127.0.0.1:3100 alone.'
      }
    } elseif ($ports.Count -ne 0) { throw "STOP: $($s.Name) publishes a port." }
  }
  foreach ($v in $cfg.volumes.PSObject.Properties) {
    if ($v.Value.name -notlike 'enginora-trial_*') { throw "STOP: volume $($v.Name) is $($v.Value.name)." }
  }
  foreach ($n in $cfg.networks.PSObject.Properties) {
    if ($n.Value.name -notlike 'enginora-trial_*') { throw "STOP: network $($n.Name) is $($n.Value.name)." }
  }
  $env_ = $cfg.services.app.environment
  if ($env_.MALWARE_SCANNER -ne 'clamav' -or $env_.SEO_INDEXABLE -ne 'false' -or $env_.STORAGE_ENDPOINT -ne 'http://storage:9000') {
    throw 'STOP: app environment is not the trial one.'
  }
  Remove-Variable cfg, env_
  'OK: enginora-trial, one port 127.0.0.1:3100, restart no, trial volumes and networks.'
}
```

**قبل كل مرحلة وبعدها:**

```powershell
Assert-TrialSafe
$before = Get-DockerNames
# ... أوامر المرحلة ...
Assert-OnlyTrialChanged $before
```

## ٤. ملف البيئة `.env.trial.local` (P2)

ملف جديد بقيم عشوائية تُولَّد على الحاسوب ولا تُطبع. لا يُنسخ من `.env.local` ولا من
ملف المعاينة. يغطيه `.env.*.local` في `.gitignore` و`**/.env.*` في `.dockerignore`.
يُكتب **ASCII**: `-Encoding UTF8` في PowerShell 5.1 يضيف BOM يفسد المفتاح الأول.

```powershell
function New-Hex([int]$Bytes = 32) {
  $b = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($b); $rng.Dispose()
  -join ($b | ForEach-Object { $_.ToString('x2') })
}

if (Test-Path .env.trial.local) { throw 'STOP: .env.trial.local exists; not overwritten.' }
$appPw = New-Hex; $migPw = New-Hex
$lines = @(
  'APP_URL=http://127.0.0.1:3100',
  "POSTGRES_SUPERUSER_PASSWORD=$(New-Hex)",
  "DATABASE_URL=postgresql://app_user:$appPw@postgres:5432/engineering_marketplace",
  "DATABASE_MIGRATION_URL=postgresql://migrator:$migPw@postgres:5432/engineering_marketplace",
  "TRIAL_APP_USER_PASSWORD=$appPw",
  "TRIAL_MIGRATOR_PASSWORD=$migPw",
  "SESSION_SECRET=$(New-Hex)",
  "CONFIG_ENCRYPTION_KEY=$(New-Hex)",
  'STORAGE_ENDPOINT=http://storage:9000',
  "STORAGE_ACCESS_KEY_ID=$(New-Hex 10)",
  "STORAGE_SECRET_ACCESS_KEY=$(New-Hex)",
  'MAIL_TRANSPORT_URL=smtp://mail.invalid:25',
  'MAIL_FROM=noreply@enginora.invalid',
  'SEO_INDEXABLE=false',
  'LOG_LEVEL=info'
)
Set-Content -Path .env.trial.local -Value $lines -Encoding ASCII
Remove-Variable appPw, migPw, lines
git check-ignore -q .env.trial.local
if ($LASTEXITCODE -ne 0) { throw 'STOP: .env.trial.local is not ignored by git.' }
git status --short
```

`git status --short` يجب ألّا يُظهر الملف. ثم:

```powershell
Assert-TrialSafe
trial config --quiet
```

## ٥. المراحل

### P2 — فحص قبل أي تشغيل (يحتاج موافقة)

**الشرط المسبق:** الحاسوب على `main` بعد دمج P1 (المالك ينفّذ التقديم السريع بنفسه
بموافقته؛ لا يُنفَّذ من هنا). ثم §٣ و§٤.

**قواعد ClamAV** في حاوية مؤقتة **بلا شبكة**، فلا محاولة اتصال بخوادم التوقيع:

```powershell
docker pull clamav/clamav-debian:1.5
docker run --rm --network none --entrypoint sh clamav/clamav-debian:1.5 -c 'ls -l /var/lib/clamav; for f in /var/lib/clamav/*.cvd /var/lib/clamav/*.cld; do [ -e $f ] && sigtool --info $f | grep -E ''^(File|Build time|Version|Verification)''; done'
```

المطلوب لكل من `main` و`daily` (و`bytecode` إن وُجد): `Verification OK`، ويُسجَّل
تاريخ البناء كما هو. **إن لم توجد القواعد تتوقف التجربة هنا.** البدائل المشروعة
(جلبها من شبكة لا ترفضها سياسة المزوّد، أو عبر شخص موثوق خارج سوريا) قرار امتثال
للمالك. لا التفاف على القيد الجغرافي، ولا تعطيل للفحص.

وحدة `enginora-trial_clamav_db` الفارغة تُملأ من محتوى الصورة عند أول ربط، فإن
وُجدت القواعد في الصورة وصلت إلى clamd.

### P3 — البناء ثم التشغيل المرحلي (يحتاج موافقة)

خدمة واحدة كل مرة، وقياس بعد كل خطوة:

```powershell
Assert-TrialSafe
$before = Get-DockerNames
trial build app
trial --profile tools build tools
trial up -d postgres storage storage-init
trial up -d clamav
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}'
Get-CimInstance Win32_OperatingSystem | ForEach-Object { 'Windows free GB: {0:N2}' -f ($_.FreePhysicalMemory / 1MB) }
Assert-OnlyTrialChanged $before
```

بعد أن يصبح clamav `healthy` (قد يستغرق دقائق؛ `start_period` عشر دقائق) يُقاس
استهلاكه، ويُراجَع `mem_limit` من القياس **قبل** تشغيل التطبيق. إن اقترب من 2g أو
قُتلت الحاوية، نتوقف ونعدّل الطبقة بـPR جديد.

### P4 — قاعدة البيانات (يحتاج موافقة)

قاعدة جديدة في `enginora-trial_postgres_data`. ملف `docker/postgres/init/01-roles.sql`
أنشأ `migrator` و`app_user` بلا كلمة مرور (B6)؛ تُضبط هنا من ملف البيئة دون طباعة:

```powershell
foreach ($line in Get-Content .env.trial.local) {
  if ($line -match '^(TRIAL_APP_USER_PASSWORD|TRIAL_MIGRATOR_PASSWORD)=(.+)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
}
$sql = @'
\getenv app_pw TRIAL_APP_USER_PASSWORD
\getenv mig_pw TRIAL_MIGRATOR_PASSWORD
SELECT format('ALTER ROLE app_user WITH PASSWORD %L', :'app_pw'), format('ALTER ROLE migrator WITH PASSWORD %L', :'mig_pw') \gexec
-- end
'@
($sql -replace "`r", '') | docker exec -i -e TRIAL_APP_USER_PASSWORD -e TRIAL_MIGRATOR_PASSWORD enginora-trial-postgres-1 psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres
Remove-Item env:TRIAL_APP_USER_PASSWORD, env:TRIAL_MIGRATOR_PASSWORD
Remove-Variable sql
```

(`-replace "`r"` لأن PowerShell يرسل CRLF، وpsql على Linux يقرأ CR جزءاً من اسم المتغيّر.)

الترحيلات من الصورة نفسها، ثم البذرتان المسموحتان والمالك:

```powershell
trial run --rm --no-deps app npm run db:migrate
docker exec enginora-trial-postgres-1 psql -tAq -U postgres -d engineering_marketplace -c 'SELECT count(*) FROM drizzle.__drizzle_migrations'
trial run --rm --no-deps app npm run db:migrate
trial --profile tools run --rm tools npm run seed:catalog
trial --profile tools run --rm tools npm run seed:payment-methods
```

المطلوب: عدد الترحيلات = عدد مدخلات `src/db/migrations/meta/_journal.json` (67 عند
`c4c58d2`)، والتشغيل الثاني لا يغيّر شيئاً.

حساب المالك للتجربة وحدها، باسم مستخدم وكلمة مرور لا يُستعملان في أي مكان آخر:

```powershell
$env:OWNER_USERNAME = 'trial-owner'
$env:OWNER_NAME = 'Trial Owner'
$s = Read-Host 'Trial owner password (12+ chars)' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
$env:OWNER_PASSWORD = $plain
trial --profile tools run --rm -e OWNER_USERNAME -e OWNER_NAME -e OWNER_PASSWORD tools npm run bootstrap:owner
Remove-Item env:OWNER_PASSWORD, env:OWNER_USERNAME, env:OWNER_NAME
Remove-Variable s, plain
```

إن لم تصل المتغيّرات إلى الحاوية تطلبها الأداة تفاعلياً (وتظهر كلمة المرور على
الشاشة أثناء الكتابة).

إثبات العزل على هذه القاعدة وحدها (السكربت ينظّف ما ينشئه):

```powershell
docker cp src/db/security/rls-foundation.test.sql enginora-trial-postgres-1:/tmp/rls.sql
docker exec enginora-trial-postgres-1 psql -v ON_ERROR_STOP=1 -U postgres -d engineering_marketplace -f /tmp/rls.sql
```

**ممنوع على هذه البيئة**: `seed:demo` و`seed:scale` و`seed:demo-media` (الأولان يكتبان
منتجات منشورة مباشرةً متجاوزين بوابة النشر).

### P5 — التطبيق ودورة الشراء (يحتاج موافقة)

```powershell
Assert-TrialSafe
$before = Get-DockerNames
trial up -d app
trial ps
Assert-OnlyTrialChanged $before
```

ثم الاختبارات في §٦.

### P6 — النسخ والاستعادة (يحتاج موافقة) — §٧

### P7 — الإيقاف (يحتاج موافقة)

```powershell
trial stop
Assert-OnlyTrialChanged $before
```

`stop` يُبقي الحاويات ووحدات التخزين. لا يُحذف شيء من هذه البيئة إلا بطلب صريح
وأمر منفصل يُراجَع وقتها.

## ٦. دورة الشراء ومعايير القبول

لا يُعلن بند ناجحاً إلا بدليل: لقطة شاشة، أو ناتج استعلام بلا أسرار، أو رمز HTTP.
بيانات وهمية فقط (أسماء وهواتف E.164 للاختبار، وبريد على `example.test`). ملف PDF
صغير (أقل من 20 MB: الرفع يُخزَّن في الذاكرة كاملاً).

| # | الخطوة | معيار القبول |
|---|---|---|
| T1 | `http://127.0.0.1:3100`، و`/api/health`، و`/robots.txt` | 200؛ وrobots فيه `Disallow: /` |
| T2 | تسجيل مشترٍ (الاسم، الهاتف، البريد) | `ACTIVE CUSTOMER` مسجَّل الدخول، والكعكة باقية بعد النقرة التالية |
| T3 | تسجيل حساب ثانٍ ثم ترقيته مهندساً من `/admin/engineers` ثم التفعيل | ملف منشأ غير مفعَّل ثم مفعَّل، وأسطر في `audit_logs` |
| T4 | المالك من `/login/owner` | ينجح؛ زائر على `/admin` يُحوَّل إلى `/login/owner`، ومشترٍ إلى `/` |
| T5 | اتفاق عمولة (`/admin/commissions`) وسعر | صفّا اتفاق وسعر مفتوحان |
| T6 | رفع PDF أصلي ومعاينته | `scan_status = CLEAN` للاثنين |
| T6b | فحص clamd مباشرة بـEICAR (أدناه) | `FOUND` |
| T6c | `trial stop clamav` ثم رفع ملف، ثم `trial start clamav` | الرفع مرفوض (`FAILED`)، ولا نشر |
| T7 | النشر | قبل T5/T6 يظهر المانع الصحيح بجانب الزر؛ بعدها `PUBLISHED` |
| T8 | تعليمات دفع وهمية في `/admin/payment-methods`، ثم شراء وإيصال وهمي | الطلب ينتظر الاعتماد، والإيصال مفحوص ويُعرض للمالك |
| T9 | اعتماد المالك | `PAID`، لقطة مالية، فاتورة متسلسلة، قيد متوازن، استحقاق، إشعار `PRODUCT_SOLD` بلا هوية المشتري، وسلسلة الدفتر سليمة (أدناه) |
| T10 | تنزيل المشتري | PDF مختوم بالاسم ورقم الطلب والتاريخ، نصّه قابل للتحديد؛ و`download_events` مسجَّل |
| T11 | زائر، ومشترٍ آخر، والمهندس للأصل، ومعرّف مشوَّه | **404** في كل حالة |
| T12 | تعديل اللقطة أو سعر قديم بدور `app_user` | رفض أو صفر صفوف، واللقطة كما هي |
| T13 | `trial stop`، ثم `trial start`، ثم إعادة تشغيل Docker Desktop | الحساب والطلب والملف والاستحقاق باقية، والتنزيل يعمل، ولا شيء عاد وحده بعد إعادة التشغيل |

EICAR يُولَّد **داخل** حاوية clamav ولا يُكتب على قرص Windows (فلا يُستثار Defender):

```powershell
docker exec enginora-trial-clamav-1 sh -c 'a=WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNU; b=QU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=; printf %s $a$b | base64 -d | clamdscan --no-summary -'
```

فحوص T6 وT9 (قراءة فقط):

```powershell
docker exec enginora-trial-postgres-1 psql -tAq -U postgres -d engineering_marketplace -c 'SELECT role, scan_status FROM product_files ORDER BY created_at'
docker exec enginora-trial-postgres-1 psql -tAq -U postgres -d engineering_marketplace -c 'SELECT set_config(''app.actor_role'',''OWNER'',true); SELECT count(*) FROM app_verify_ledger_chain()'
```

السطر الأخير من الثاني يجب أن يكون `0` (لا قيد مكسور).

## ٧. النسخ والاستعادة (P6)

لا `npm run backup` ولا `restore-drill`: كلاهما مبني على التشفير والشحن الخارجي
ومتغيّرات `BACKUP_*`. النسخة تُكتب **خارج المستودع**. ولا `>` في PowerShell 5.1:
يفسد المخرج الثنائي، فالملف يُكتب داخل الحاوية ثم يُنسخ.

```powershell
$dir = "C:\enginora-trial-backups\$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Path $dir | Out-Null
docker exec enginora-trial-postgres-1 pg_dump -Fc -U postgres -d engineering_marketplace -f /tmp/trial.dump
docker exec enginora-trial-postgres-1 pg_dumpall -U postgres --roles-only -f /tmp/trial-roles.sql
docker cp enginora-trial-postgres-1:/tmp/trial.dump "$dir\trial.dump"
docker cp enginora-trial-postgres-1:/tmp/trial-roles.sql "$dir\trial-roles.sql"
docker exec enginora-trial-postgres-1 rm /tmp/trial.dump /tmp/trial-roles.sql
trial run --rm --no-deps --entrypoint aws -v "$dir\storage:/backup" storage-init --endpoint-url http://storage:9000 s3 sync s3://em-originals /backup/em-originals
trial run --rm --no-deps --entrypoint aws -v "$dir\storage:/backup" storage-init --endpoint-url http://storage:9000 s3 sync s3://em-derivatives /backup/em-derivatives
```

`trial-roles.sql` يحمل تجزئات كلمات المرور: يُعامل كسرّ.

**الاستعادة** في حاوية PostgreSQL مؤقتة **بلا شبكة وبلا منفذ وبلا وحدة تخزين مسمّاة**،
تُزال وحدها عند إيقافها (`--rm`):

```powershell
$env:RESTORE_PG_PASSWORD = New-Hex
docker run -d --rm --name enginora-trial-restore-pg --network none -e POSTGRES_PASSWORD=$env:RESTORE_PG_PASSWORD postgres:16-alpine
Remove-Item env:RESTORE_PG_PASSWORD
docker exec enginora-trial-restore-pg pg_isready -h 127.0.0.1 -U postgres
docker cp "$dir\trial-roles.sql" enginora-trial-restore-pg:/tmp/roles.sql
docker cp "$dir\trial.dump" enginora-trial-restore-pg:/tmp/trial.dump
docker exec enginora-trial-restore-pg psql -q -U postgres -f /tmp/roles.sql
docker exec enginora-trial-restore-pg createdb -U postgres engineering_marketplace
docker exec enginora-trial-restore-pg pg_restore -U postgres -d engineering_marketplace --exit-on-error /tmp/trial.dump
```

(`pg_isready` يُكرَّر حتى يُجيب؛ وسطر `role "postgres" already exists` من ملف الأدوار متوقَّع.)

**المقارنة** — الناتج متطابق بين `enginora-trial-postgres-1` و`enginora-trial-restore-pg`:

```powershell
$q = 'SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM orders), (SELECT count(*) FROM order_items), (SELECT count(*) FROM invoices), (SELECT count(*) FROM entitlements), (SELECT count(*) FROM ledger_lines), (SELECT count(*) FROM product_files), (SELECT count(*) FROM drizzle.__drizzle_migrations)'
foreach ($c in 'enginora-trial-postgres-1', 'enginora-trial-restore-pg') { docker exec $c psql -tAq -U postgres -d engineering_marketplace -c $q }
docker exec enginora-trial-restore-pg psql -tAq -U postgres -d engineering_marketplace -c 'SELECT set_config(''app.actor_role'',''OWNER'',true); SELECT count(*) FROM app_verify_ledger_chain()'
docker exec enginora-trial-restore-pg psql -tAq -U postgres -d engineering_marketplace -c 'SELECT storage_key, sha256 FROM product_files WHERE role = ''ORIGINAL'''
Get-ChildItem -Recurse -File -Path "$dir\storage\em-originals" | Get-FileHash -Algorithm SHA256
docker stop enginora-trial-restore-pg
```

بصمة كل أصل في نسخة التخزين تطابق `sha256` المسجَّلة في القاعدة المستعادة
(`Get-FileHash` يكتبها بأحرف كبيرة). سلسلة الدفتر في القاعدة المستعادة: `0`.

## ٨. ما لا تُثبته هذه البيئة

- **الإنتاج**: لا TLS، ولا نطاق، ولا R2، ولا SMTP، ولا معالج Ampere A1.
- **الملفات غير PDF**: تسليمها لا يعمل من Windows هنا (§٢).
- **Firefox**.
- **رفع ملفات كبيرة**: ذاكرة الحاسوب لا تتّسع لها.
- **عمر قواعد ClamAV**: لا يفحصه الكود؛ قاعدة قديمة تُجيب `OK` على ما لا تعرفه.

## ٩. المراجع

- `docker-compose.trial.yml` (ترويسته تشرح كل فرق عن الإنتاج)
- `src/lib/config/trial-stack.test.ts`
- `docker-compose.preview.yml` و`docs/PROJECT_STATE.md` (المعاينة، وهي محمية)
- `docs/DEPLOYMENT.md` §4-a و`scripts/image-smoke.sh` (الصورة)
