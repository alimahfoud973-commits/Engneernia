/**
 * Seeds the payment methods the platform can actually offer today.
 *
 *   node --experimental-strip-types scripts/seed-payment-methods.ts
 *
 * Decisions §2: the merchant operates from Syria, so no international gateway
 * is assumed available. Manual transfer and WhatsApp assistance are seeded
 * ACTIVE; the card gateway is seeded INACTIVE and carries no credentials — it
 * exists so enabling one later is configuration, not a rewrite, and so the
 * checkout never shows a button that cannot complete (§22).
 *
 * Every field here is owner-editable from the admin console afterwards.
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

const METHODS = [
  {
    code: 'bank-transfer',
    type: 'MANUAL',
    display_name_ar: 'تحويل بنكي',
    display_name_en: 'Bank Transfer',
    description_ar: 'حوّل المبلغ إلى الحساب البنكي، ثم ارفع صورة الإيصال.',
    instructions_ar:
      'حوّل المبلغ المذكور إلى الحساب أدناه، واكتب رقم الطلب في خانة البيان.\n'
      + 'بعد التحويل ارفع صورة الإيصال، وسيُراجع الطلب ويُفعَّل الوصول خلال مدة قصيرة.',
    account_details_ar: 'يُعبّئها المالك من لوحة الإدارة',
    requires_proof: true,
    countries: [],
    currencies: ['USD'],
    is_active: true,
    sort_order: 1,
  },
  {
    code: 'shamcash',
    type: 'MANUAL',
    display_name_ar: 'شام كاش',
    display_name_en: 'ShamCash',
    description_ar: 'الدفع عبر محفظة شام كاش، ثم رفع إثبات الحوالة.',
    instructions_ar:
      'أرسل المبلغ إلى المحفظة أدناه، ثم ارفع صورة إشعار الحوالة مع رقم العملية.',
    account_details_ar: 'يُعبّئها المالك من لوحة الإدارة',
    requires_proof: true,
    countries: ['SY'],
    currencies: ['USD'],
    is_active: false, // enabled once the owner fills in the wallet details
    sort_order: 2,
  },
  {
    code: 'whatsapp-assist',
    type: 'ASSISTED',
    display_name_ar: 'المساعدة عبر واتساب',
    display_name_en: 'WhatsApp Assistance',
    description_ar: 'تواجه صعوبة في الدفع؟ تواصل معنا مباشرة.',
    instructions_ar: 'سيتم تحويلك إلى محادثة واتساب تحمل تفاصيل طلبك.',
    support_message_ar:
      'مرحباً، أرغب بشراء:\n{{items}}\nرقم الطلب: {{order}}\nالمبلغ: {{amount}} {{currency}}',
    requires_proof: false,
    countries: [],
    currencies: [],
    is_active: true,
    sort_order: 9,
  },
  {
    code: 'card-gateway',
    type: 'GATEWAY',
    display_name_ar: 'بطاقة ائتمان',
    display_name_en: 'Credit / Debit Card',
    description_ar: 'غير مفعّلة — تتطلب حساب تاجر لدى بوابة دفع.',
    requires_proof: false,
    countries: [],
    currencies: ['USD'],
    is_active: false,
    sort_order: 10,
  },
] as const;

try {
  for (const m of METHODS) {
    await sql`
      INSERT INTO payment_methods (
        code, type, display_name_ar, display_name_en, description_ar,
        instructions_ar, account_details_ar, support_message_ar,
        requires_proof, countries, currencies, is_active, sort_order
      ) VALUES (
        ${m.code}, ${m.type}::payment_method_type, ${m.display_name_ar},
        ${m.display_name_en}, ${m.description_ar},
        ${'instructions_ar' in m ? m.instructions_ar : null},
        ${'account_details_ar' in m ? m.account_details_ar : null},
        ${'support_message_ar' in m ? m.support_message_ar : null},
        ${m.requires_proof}, ${m.countries as unknown as string[]},
        ${m.currencies as unknown as string[]}, ${m.is_active}, ${m.sort_order}
      )
      ON CONFLICT (code) DO UPDATE SET
        display_name_ar = EXCLUDED.display_name_ar,
        description_ar  = EXCLUDED.description_ar,
        sort_order      = EXCLUDED.sort_order,
        updated_at      = now()
    `;
  }

  const active = await sql<Array<{ code: string; is_active: boolean }>>`
    SELECT code, is_active FROM payment_methods ORDER BY sort_order
  `;
  console.log('Payment methods:');
  for (const row of active) {
    console.log(`  ${row.is_active ? 'ACTIVE  ' : 'inactive'} ${row.code}`);
  }
  console.log('\nNEXT: fill in the account details from the admin console before');
  console.log('taking real money, and set support.whatsapp in settings.');
} catch (error) {
  console.error(`Payment method seeding failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
