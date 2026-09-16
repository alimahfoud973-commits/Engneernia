/**
 * Test accounts for a local preview run. Development only.
 *
 * Creates an owner with an armed second factor, an engineer with a product and
 * a completed sale, and a customer — so every screen has something real to
 * show. Refuses to run unless NODE_ENV is development.
 */
import postgres from 'postgres';
import { hash as argonHash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { encryptSecret } from '@/auth/crypto';
import { generateTotpSecret, generateTotp } from '@/auth/totp';

process.loadEnvFile('.env.local');
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed preview accounts in production.');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_MIGRATION_URL!, { onnotice: () => {} });
const OWNER_PW = 'OwnerPassphrase9!x';
const USER_PW = 'CorrectHorseBattery9!';
const secret = generateTotpSecret();
const t = Date.now();

await sql`SELECT set_config('app.actor_role','OWNER',false)`;

const [owner] = await sql`SELECT id, email FROM users WHERE role='OWNER' LIMIT 1`;
if (!owner) { console.error('No owner row. Run bootstrap:owner first.'); process.exit(1); }
await sql`UPDATE users SET password_hash=${await argonHash(OWNER_PW)},
            totp_secret_encrypted=${encryptSecret(secret)}, totp_enabled_at=now(),
            email_verified_at=COALESCE(email_verified_at, now()), status='ACTIVE'
          WHERE id=${owner.id}`;

const engUser = randomUUID(), contrib = randomUUID(), prod = randomUUID(), buyer = randomUUID();
const [disc] = await sql`SELECT id FROM disciplines WHERE slug = 'civil' LIMIT 1`;
if (!disc) { console.error('No civil discipline. Run seed:catalog first.'); process.exit(1); }

await sql`INSERT INTO users (id,email,password_hash,role,status,display_name,email_verified_at)
          VALUES (${engUser},'engineer@preview.local',${await argonHash(USER_PW)},'CONTRIBUTOR','ACTIVE','م. سامر الحلبي',now())
          ON CONFLICT (email) DO NOTHING`;
await sql`INSERT INTO contributors (id,user_id,public_slug,settlement_code,display_name,specialization,is_active)
          VALUES (${contrib},${engUser},${'preview-eng-'+t},${'PRV'+t},'م. سامر الحلبي','هندسة مدنية',true)`;
await sql`INSERT INTO products (id,slug,title_ar,subtitle_ar,description_ar,discipline_id,file_type,status,currency,level,published_at)
          VALUES (${prod},${'preview-guide-'+t},'دليل تصميم الأساسات السطحية','حساب القدرة الاستيعابية والهبوط',
                  'مرجع عملي لتصميم الأساسات المنفردة والمشتركة وفق الكود.',${disc.id},'PDF','PUBLISHED','USD','INTERMEDIATE',now())`;
await sql`INSERT INTO product_contributors (product_id,contributor_id,share_bp) VALUES (${prod},${contrib},10000)`;
await sql`INSERT INTO product_prices (product_id,amount_minor,currency) VALUES (${prod},3500,'USD')`;
await sql`INSERT INTO commission_agreements (contributor_id,model,engineer_bp,currency)
          VALUES (${contrib},'PERCENTAGE',8000,'USD')`;

await sql`INSERT INTO users (id,email,password_hash,role,status,display_name,country_code,email_verified_at)
          VALUES (${buyer},'customer@preview.local',${await argonHash(USER_PW)},'CUSTOMER','ACTIVE','عميل المعاينة','SY',now())
          ON CONFLICT (email) DO NOTHING`;

const [order] = await sql`INSERT INTO orders (order_number,customer_id,status,currency,subtotal_minor,discount_minor,total_minor,paid_at,completed_at)
          VALUES (${'PRV-'+t},${buyer},'COMPLETED','USD',3500,0,3500,now(),now()) RETURNING id`;
if (!order) { console.error('Could not create the sample order.'); process.exit(1); }
const [item] = await sql`INSERT INTO order_items
  (order_id,product_id,title_snapshot,unit_price_minor,discount_minor,currency,
   commission_model,engineer_bp,engineer_amount_minor,platform_amount_minor,tax_bp,tax_minor,net_minor,snapshot_taken_at)
  VALUES (${order.id},${prod},'دليل تصميم الأساسات السطحية',3500,0,'USD','PERCENTAGE',8000,2800,700,0,0,3500,now())
  RETURNING id`;
if (!item) { console.error('Could not create the sample order item.'); process.exit(1); }
await sql`INSERT INTO order_item_contributors
  (order_item_id,contributor_id,share_bp,slice_minor,amount_minor,platform_amount_minor,commission_model,engineer_bp,currency,occurred_at)
  VALUES (${item.id},${contrib},10000,3500,2800,700,'PERCENTAGE',8000,'USD',now())`;
await sql`INSERT INTO entitlements (customer_id,product_id,order_item_id) VALUES (${buyer},${prod},${item.id})`;

console.log(JSON.stringify({
  owner: { email: owner.email, password: OWNER_PW, totpSecret: secret, codeNow: generateTotp(secret) },
  engineer: { email: 'engineer@preview.local', password: USER_PW },
  customer: { email: 'customer@preview.local', password: USER_PW },
  productSlug: 'preview-guide-' + t,
}, null, 2));
await sql.end();
