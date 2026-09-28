/**
 * Test accounts for a local preview run. Development only.
 *
 * Sets the owner's password, and creates an engineer with a product and a
 * customer — so every screen has something real to show. Subscribers and
 * engineers sign in with phone + email (Stage 6); the owner with username +
 * password. Refuses to run unless NODE_ENV is development.
 */
import postgres from 'postgres';
import { hash as argonHash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';

process.loadEnvFile('.env.local');
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed preview accounts in production.');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_MIGRATION_URL!, { onnotice: () => {} });
const OWNER_PW = 'OwnerPassphrase9!x';
const t = Date.now();

await sql`SELECT set_config('app.actor_role','OWNER',false)`;

const [owner] = await sql`SELECT id, username FROM users WHERE role='OWNER' LIMIT 1`;
if (!owner) { console.error('No owner row. Run bootstrap:owner first.'); process.exit(1); }
await sql`UPDATE users SET password_hash=${await argonHash(OWNER_PW)}, status='ACTIVE'
          WHERE id=${owner.id}`;

/*
 * RE-RUNNABLE. The first version used `ON CONFLICT (email) DO NOTHING` on the
 * users, which meant a second run inserted nothing and then pointed a new
 * contributor row at a user id that had never been created — a foreign-key
 * violation that read as if the database were broken. Prior preview rows are
 * removed first instead, in dependency order.
 */
const PREVIEW_EMAILS = ['engineer@preview.local', 'customer@preview.local', 'newbuyer@preview.local'];

const priorUsers = await sql`SELECT id FROM users WHERE email = ANY(${PREVIEW_EMAILS})`;
const priorIds = priorUsers.map((r) => r.id as string);
if (priorIds.length > 0) {
  await sql`DELETE FROM entitlements WHERE customer_id = ANY(${priorIds})`;
  await sql`DELETE FROM orders WHERE customer_id = ANY(${priorIds})`;
  const priorContribs = await sql`SELECT id FROM contributors WHERE user_id = ANY(${priorIds})`;
  const contribIds = priorContribs.map((r) => r.id as string);
  if (contribIds.length > 0) {
    const priorProducts = await sql`
      SELECT DISTINCT product_id FROM product_contributors WHERE contributor_id = ANY(${contribIds})`;
    const productIds = priorProducts.map((r) => r.product_id as string);
    await sql`DELETE FROM commission_agreements WHERE contributor_id = ANY(${contribIds})`;
    await sql`DELETE FROM product_contributors WHERE contributor_id = ANY(${contribIds})`;
    if (productIds.length > 0) {
      await sql`DELETE FROM product_files WHERE product_id = ANY(${productIds})`;
      await sql`DELETE FROM product_prices WHERE product_id = ANY(${productIds})`;
      await sql`DELETE FROM products WHERE id = ANY(${productIds})`;
    }
    await sql`DELETE FROM contributors WHERE id = ANY(${contribIds})`;
  }
  await sql`DELETE FROM users WHERE id = ANY(${priorIds})`;
}

const engUser = randomUUID(), contrib = randomUUID(), prod = randomUUID(), buyer = randomUUID();
const [disc] = await sql`SELECT id FROM disciplines WHERE slug = 'civil' LIMIT 1`;
if (!disc) { console.error('No civil discipline. Run seed:catalog first.'); process.exit(1); }

await sql`INSERT INTO users (id,email,phone,role,status,display_name)
          VALUES (${engUser},'engineer@preview.local','+963900000101','CONTRIBUTOR','ACTIVE','م. سامر الحلبي')`;
await sql`INSERT INTO contributors (id,user_id,public_slug,settlement_code,display_name,specialization,is_active)
          VALUES (${contrib},${engUser},${'preview-eng-'+t},${'PRV'+t},'م. سامر الحلبي','هندسة مدنية',true)`;
await sql`INSERT INTO products (id,slug,title_ar,subtitle_ar,description_ar,discipline_id,file_type,status,currency,level,published_at)
          VALUES (${prod},${'preview-guide-'+t},'دليل تصميم الأساسات السطحية','حساب القدرة الاستيعابية والهبوط',
                  'مرجع عملي لتصميم الأساسات المنفردة والمشتركة وفق الكود.',${disc.id},'PDF','PUBLISHED','USD','INTERMEDIATE',now())`;
await sql`INSERT INTO product_contributors (product_id,contributor_id,share_bp) VALUES (${prod},${contrib},10000)`;
await sql`INSERT INTO product_prices (product_id,amount_minor,currency) VALUES (${prod},3500,'USD')`;
await sql`INSERT INTO commission_agreements (contributor_id,model,engineer_bp,currency)
          VALUES (${contrib},'PERCENTAGE',8000,'USD')`;

await sql`INSERT INTO users (id,email,phone,role,status,display_name,country_code)
          VALUES (${buyer},'customer@preview.local','+963900000102','CUSTOMER','ACTIVE','عميل المعاينة','SY')`;

/*
 * NO MANUFACTURED SALE HERE.
 *
 * An earlier version inserted an order, an order item and a contributor split
 * directly — which produced a sale the DOUBLE-ENTRY LEDGER had never heard of.
 * The settlement run then found earnings it could not itemise and added a
 * balancing line reading "تسوية فرق غير مفصّل" to every statement, which looks
 * exactly like a defect in the settlement engine and is not one.
 *
 * The ledger is the financial authority (P6), so nothing may create a sale
 * except the sale path. Buy the product through the site, or approve a payment
 * in /admin/payments, and every figure downstream follows correctly.
 */

console.log(JSON.stringify({
  owner: { username: owner.username, password: OWNER_PW },
  engineer: { phone: '+963900000101', email: 'engineer@preview.local' },
  customer: { phone: '+963900000102', email: 'customer@preview.local' },
  productSlug: 'preview-guide-' + t,
}, null, 2));
await sql.end();
