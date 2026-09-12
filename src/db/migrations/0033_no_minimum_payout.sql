-- ===========================================================================
-- OWNER DECISION: NO MINIMUM PAYOUT
--
-- "لا اريد أن يكون هناك حد أدنى"
--
-- Decisions §8 originally suggested 50 USD and, more importantly, said the
-- number must be a setting rather than a constant in the code. That
-- instruction still holds, so the MECHANISM stays and only its VALUE changes:
-- zero means every positive balance is payable in the month it arises.
--
-- Deleting the setting instead would have satisfied today's decision and
-- broken the earlier one — reinstating a threshold later would become a code
-- change and a deploy, which is exactly what the owner asked to avoid.
--
-- Statements already issued are NOT touched. Each one froze the threshold that
-- applied when it was written (migration 0032), so the reason an old month
-- paid nothing stays readable and true.
-- ===========================================================================

SELECT set_config('app.actor_role', 'OWNER', true);
--> statement-breakpoint

UPDATE settings
   SET value = '0'::jsonb,
       description_ar =
         'الحد الأدنى لصرف مستحقات المهندس بالوحدات الصغرى. '
         || 'القيمة 0 تعني بلا حد أدنى: كل رصيد موجب يُصرف في تسوية شهره. '
         || 'الكشوف الصادرة سابقاً تحتفظ بالحد الذي كان سارياً وقت إصدارها.'
 WHERE key = 'settlement.minimumPayoutMinor';
