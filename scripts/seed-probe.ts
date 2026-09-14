/**
 * =============================================================================
 * FIXTURES FOR THE SECURITY PROBE
 * =============================================================================
 *   node --experimental-strip-types scripts/seed-probe.ts
 *
 * `scripts/security-probe.mjs` needs two accounts it can sign in as and two
 * ids belonging to SOMEBODY ELSE — a settlement and a payment receipt — so it
 * can prove that asking for them over HTTP returns nothing.
 *
 * Until now those had to be assembled by hand, which is the reason the probe
 * was run once and not since. A security check nobody can re-run is a check
 * that stops being true without anybody noticing. This makes it one command,
 * and prints the exact environment to paste.
 *
 * STAGING ONLY. It creates accounts with a known password and a settlement
 * that was never earned. Pointing it at production would put a usable
 * credential in a real database — so it refuses to run against one.
 * =============================================================================
 */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { hash as argonHash } from '@node-rs/argon2';

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_SUPERUSER_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL or DATABASE_SUPERUSER_URL must be set.');
  process.exit(1);
}

/**
 * The one guard that matters here. A fixture password in a production database
 * is a back door, and it would be created by a script somebody ran by mistake
 * rather than by an attacker — which is how it would go unnoticed.
 */
if (process.env.NODE_ENV === 'production' || process.env.ALLOW_PROBE_SEED !== 'yes') {
  console.error('\nRefusing to seed probe fixtures.');
  console.error('These are accounts with a KNOWN PASSWORD. They belong in a staging');
  console.error('database and nowhere else.\n');
  console.error('If this is staging, re-run with ALLOW_PROBE_SEED=yes.\n');
  process.exit(1);
}

const PASSWORD = 'probe-password-that-is-long-enough';
const sql = postgres(url, { max: 1 });
const stamp = Date.now();

try {
  const passwordHash = await argonHash(PASSWORD, {
    algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
  });

  /**
   * EVERYTHING IN ONE TRANSACTION.
   *
   * `set_config(..., true)` is transaction-local, and postgres.js runs each
   * statement in its own implicit transaction — so declaring the actor once
   * and then inserting lost the context immediately, and `settlements`, which
   * carries FORCE ROW LEVEL SECURITY, refused the write. Found by running it.
   *
   * A transaction is also simply correct here: a half-created fixture is
   * worse than none, because the probe would then fail for the wrong reason.
   */
  const ids = {
    engineerUser: randomUUID(), engineer: randomUUID(),
    strangerUser: randomUUID(), stranger: randomUUID(),
    customer: randomUUID(), order: randomUUID(), payment: randomUUID(),
    method: randomUUID(), settlement: randomUUID(), proof: randomUUID(),
  };
  const engineerEmail = `probe-engineer+${stamp}@test.local`;
  let ownerEmail = '';
  let foreignInvoiceId = '';

  await sql.begin(async (tx) => {
  await tx`SELECT set_config('app.actor_role', 'OWNER', true)`;

  // --- the owner --------------------------------------------------------
  // There is exactly one (migration 0041), so the fixture ADOPTS it rather
  // than making a second — which the unique index would refuse anyway.
  const [owner] = await tx<Array<{ id: string; email: string }>>`
    SELECT id, email::text AS email FROM users WHERE role = 'OWNER' LIMIT 1
  `;
  if (!owner) {
    throw new Error('No owner account. Run `npm run bootstrap:owner` first.');
  }
  ownerEmail = owner.email;
  await tx`
    UPDATE users SET password_hash = ${passwordHash}, status = 'ACTIVE',
                     email_verified_at = now(), failed_login_count = 0,
                     locked_until = NULL, totp_secret_encrypted = NULL,
                     totp_enabled_at = NULL
     WHERE id = ${owner.id}::uuid
  `;

  // --- two engineers, so one can be asked for the other's statement -----

  await tx`
    INSERT INTO users (id, email, password_hash, role, status, display_name, email_verified_at)
    VALUES
      (${ids.engineerUser}::uuid, ${engineerEmail}, ${passwordHash}, 'CONTRIBUTOR', 'ACTIVE', 'Probe Engineer', now()),
      (${ids.strangerUser}::uuid, ${`probe-stranger+${stamp}@test.local`}, ${passwordHash}, 'CONTRIBUTOR', 'ACTIVE', 'Probe Stranger', now()),
      (${ids.customer}::uuid, ${`probe-customer+${stamp}@test.local`}, ${passwordHash}, 'CUSTOMER', 'ACTIVE', 'Probe Customer', now())
  `;

  await tx`
    INSERT INTO contributors (id, user_id, public_slug, settlement_code, display_name, is_active)
    VALUES
      (${ids.engineer}::uuid, ${ids.engineerUser}::uuid, ${`probe-eng-${stamp}`}, ${`PRBE${stamp}`}, 'Probe Engineer', true),
      (${ids.stranger}::uuid, ${ids.strangerUser}::uuid, ${`probe-str-${stamp}`}, ${`PRBS${stamp}`}, 'Probe Stranger', true)
  `;

  // --- a settlement belonging to the STRANGER ---------------------------
  // The probe signs in as the engineer and asks for this. The correct answer
  // is 404 — the same answer as for a settlement that does not exist.
  await tx`
    INSERT INTO settlements (
      id, reference, contributor_id, contributor_name, settlement_code,
      period_key, period_start, period_end_exclusive, currency, status,
      period_sales_minor, period_refunds_minor, period_adjustments_minor,
      period_gross_sales_minor, period_units_sold, carried_forward_minor,
      net_due_minor, balance_minor, minimum_payout_minor, generated_at
    ) VALUES (
      ${ids.settlement}::uuid, ${`PRB-${stamp}`}, ${ids.stranger}::uuid,
      'Probe Stranger', ${`PRBS${stamp}`},
      '2026-08', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 'USD', 'PENDING',
      424242, 0, 0, 530303, 3, 0, 424242, 424242, 0, now()
    )
  `;

  // --- a receipt belonging to the CUSTOMER ------------------------------
  await tx`
    INSERT INTO payment_methods (id, code, type, display_name_ar, instructions_ar,
                                 requires_proof, countries, currencies, is_active, sort_order)
    VALUES (${ids.method}::uuid, ${`probe-bank-${stamp}`}, 'MANUAL', 'تحويل', 'حوّل',
            true, '{}', ARRAY['USD'], true, 99)
  `;
  await tx`
    INSERT INTO orders (id, order_number, customer_id, status, currency,
                        subtotal_minor, discount_minor, total_minor)
    VALUES (${ids.order}::uuid, ${`PRB-${stamp}`}, ${ids.customer}::uuid,
            'PROOF_SUBMITTED', 'USD', 424242, 0, 424242)
  `;
  await tx`
    INSERT INTO payments (id, order_id, payment_method_id, status, amount_minor, currency)
    VALUES (${ids.payment}::uuid, ${ids.order}::uuid, ${ids.method}::uuid,
            'PROOF_SUBMITTED', 424242, 'USD')
  `;
  await tx`
    INSERT INTO payment_proofs (id, payment_id, storage_key, content_type, byte_size,
                                reference_note, submitted_by, submitted_at, decision)
    VALUES (${ids.proof}::uuid, ${ids.payment}::uuid, ${`probe/${stamp}.png`},
            'image/png', 1024, 'PROBE-REF', ${ids.customer}::uuid, now(), 'PENDING')
  `;

  });

  /**
   * CLEAR THE RATE-LIMIT BUCKETS.
   *
   * The probe signs in several times and registers three accounts. Run twice
   * in a row it trips the platform's own limiters — and then reports that the
   * engineer cannot sign in, and that two registration answers differ. Both
   * read exactly like security failures and neither is one.
   *
   * That is worse than an inconvenience: a check that cries wolf when re-run
   * is a check nobody re-runs. Clearing the buckets here, in the step that is
   * documented to run immediately before the probe, is what makes the whole
   * review repeatable — which was the point of writing this seeder at all.
   */
  await sql`DELETE FROM rate_limit_buckets WHERE key LIKE 'login:%' OR key LIKE 'register:%' OR key LIKE 'resend:%'`;

  // Any invoice will do: none of them belongs to the probe's engineer, which
  // is the only property the check depends on.
  const [invoice] = await sql<Array<{ id: string }>>`
    SELECT id FROM invoices ORDER BY issued_at DESC LIMIT 1
  `;
  foreignInvoiceId = invoice?.id ?? '';

  console.log('\nProbe fixtures created. Export these, then run the probe:\n');
  console.log(`export PROBE_OWNER_EMAIL='${ownerEmail}'`);
  console.log(`export PROBE_OWNER_PASSWORD='${PASSWORD}'`);
  console.log(`export PROBE_ENGINEER_EMAIL='${engineerEmail}'`);
  console.log(`export PROBE_ENGINEER_PASSWORD='${PASSWORD}'`);
  console.log(`export PROBE_FOREIGN_SETTLEMENT_ID='${ids.settlement}'`);
  console.log(`export PROBE_FOREIGN_PROOF_ID='${ids.proof}'`);
  if (foreignInvoiceId) {
    console.log(`export PROBE_FOREIGN_INVOICE_ID='${foreignInvoiceId}'`);
  } else {
    console.log('# No invoice exists yet — the invoice checks will be skipped.');
    console.log('# Complete one purchase, then run this again.');
  }
  console.log('\n  node scripts/security-probe.mjs http://localhost:3000\n');
  console.log('Rate-limit buckets were cleared. Re-run THIS script before each');
  console.log('probe run, or the limiters will report failures that are not.\n');
} finally {
  await sql.end();
}
