-- ===========================================================================
-- FINANCIAL POLICY AS DATA (decisions §7, §8)
--
-- The owner was explicit about both numbers this phase needs:
--
--   "لا تضع مدة ثابتة مثل 7 أو 14 يومًا في الكود في هذه المرحلة"
--   "لا تجعل الحد الأدنى رقمًا ثابتًا داخل الكود ... الاقتراح الافتراضي 50 USD"
--
-- So neither exists in the application. They are rows, editable from the admin
-- console, read at the moment the question is asked.
--
-- The minimum payout ALREADY exists as settlement.minimumPayoutMinor, seeded
-- in migration 0017. It is reused rather than duplicated under a second name:
-- two settings that mean the same thing drift apart, and then nobody can say
-- which one the code actually read.
--
-- Two defaults below deserve their reasoning recorded, because a default IS a
-- decision and choosing one silently is the invention this project forbids:
--
--   refunds.requestWindowDays = null
--     Not "refunds are never late" — rather, no request is rejected by a clock
--     the owner never set. Every request reaches the owner, which is what
--     decisions §7 asks for ("يمر Refund عبر مراجعة المالك"). Setting a number
--     later turns the window into an automatic filter.
--
--   refunds.blockAfterDownload = false
--     Decisions §7 lists "الملف التالف" and "الملف لا يطابق الوصف" among the
--     valid reasons. Both are discovered BY downloading. Blocking a request
--     once the file has been fetched would make the owner's own stated reasons
--     unreachable. The download count is shown to the owner at review instead,
--     where it is evidence rather than a gate.
-- ===========================================================================

-- FORCE ROW LEVEL SECURITY applies to the table owner too, so a migration with
-- no actor context is refused — correctly. Declare what this seed is.
SELECT set_config('app.actor_role', 'OWNER', true);
--> statement-breakpoint

INSERT INTO settings (key, value, description_ar, is_public) VALUES
  ('refunds.requestWindowDays', 'null'::jsonb,
   'المدة المسموحة لتقديم طلب استرجاع بعد الشراء، بالأيام. القيمة null تعني بلا حد زمني: كل طلب يصل إلى المالك ليقرر فيه.',
   true),
  ('refunds.blockAfterDownload', 'false'::jsonb,
   'هل يُمنع طلب الاسترجاع بعد تنزيل الملف الأصلي؟ الافتراضي «لا»، لأن «الملف التالف» و«لا يطابق الوصف» لا يُكتشفان إلا بالتنزيل. عدد التنزيلات يظهر للمالك عند المراجعة.',
   true),
  ('settlement.currency', '"USD"'::jsonb,
   'عملة التسوية مع المهندسين.',
   true)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

-- The minimum payout is a TERM OF THE CONTRIBUTOR AGREEMENT, and decisions §9
-- puts it on the engineer's own monthly statement. A contributor must be able
-- to read the threshold their balance is measured against; keeping it owner-
-- only would mean the statement could not explain itself.
UPDATE settings
   SET is_public = true,
       description_ar = 'الحد الأدنى لصرف مستحقات المهندس بالوحدات الصغرى. 5000 = 50 دولاراً (اقتراح المالك، قرارات §8). ما دون ذلك يُرحَّل إلى الشهر التالي ويظهر في كشف المهندس.'
 WHERE key = 'settlement.minimumPayoutMinor';
