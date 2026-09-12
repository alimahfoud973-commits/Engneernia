-- Settings split by audience: a brand name is public, a payment credential is
-- not. The `is_public` flag on each row decides, and RLS enforces it — a
-- future admin screen cannot leak a secret by forgetting a WHERE clause.
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "settings_select" ON "settings" FOR SELECT
  USING (app_is_owner() OR "is_public" = true);
--> statement-breakpoint

CREATE POLICY "settings_write" ON "settings" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- Seed.
--
-- FORCE ROW LEVEL SECURITY applies to the table owner as well, so a migration
-- with no actor context is refused — correctly. Declaring owner context here
-- says plainly what this seed is doing rather than weakening the policy to
-- let a migration through.
SELECT set_config('app.actor_role', 'OWNER', true);
--> statement-breakpoint

-- The platform name is taken from the repository the owner created and is
-- marked for confirmation (OPEN-8): one row to change, not a value compiled
-- into the application.
INSERT INTO settings (key, value, description_ar, is_public) VALUES
  ('platform.name', '"Engineernia"'::jsonb, 'اسم المنصة الظاهر للعموم', true),
  ('platform.nameAr', '"إنجينيرنيا"'::jsonb, 'اسم المنصة بالعربية', true),
  ('platform.tagline', '"المعرفة الهندسية والموارد الرقمية"'::jsonb, 'الشعار النصي', true),
  ('preview.pageCount', '5'::jsonb, 'عدد صفحات المعاينة العامة', true),
  ('catalog.showSalesCount', 'false'::jsonb, 'إظهار عدد المبيعات للعموم', true),
  ('support.whatsapp', '""'::jsonb, 'رقم واتساب للمساعدة في الدفع', true),
  ('settlement.minimumPayoutMinor', '5000'::jsonb, 'الحد الأدنى للتسوية بالوحدات الصغرى', false),
  ('refund.policyAr', '""'::jsonb, 'سياسة الاسترجاع المعروضة للعملاء', true)
ON CONFLICT (key) DO NOTHING;
