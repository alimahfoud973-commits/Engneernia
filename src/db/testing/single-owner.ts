import { sql } from 'drizzle-orm';
import { withRawActorContext } from '@/db/actor-context';

/**
 * THE owner row, for integration tests.
 *
 * Used only by `*.itest.ts`; nothing in the application imports this.
 *
 * Every integration file used to insert an owner of its own. Once migration
 * 0041 made "one owner" a unique index, that stopped being possible — and it
 * was never a shape production could have had. The fixture now mirrors the
 * real thing: one owner in the database, shared by whoever needs one.
 *
 * IDEMPOTENT, AND IT NEVER DELETES. Files run in sequence
 * (`fileParallelism: false`), but an interrupted run leaves rows behind, and a
 * fixture that only works on a clean database is a fixture that fails on the
 * second run and looks like a real defect. `ON CONFLICT DO NOTHING` covers
 * both the email index and the single-owner index, so calling this twice — or
 * against a database that already has an owner from `bootstrap:owner` — is a
 * no-op that returns the owner already there.
 */

export const TEST_OWNER_EMAIL = 'test-owner@test.local';
const CTX = { actorId: '00000000-0000-0000-0000-0000000000ff', actorRole: 'OWNER' };

export interface TestOwnerPatch {
  /** Some files assert on the name the owner acted under. */
  readonly displayName?: string;
  readonly passwordHash?: string;
  readonly totpSecretEncrypted?: string | null;
  readonly totpEnabledAt?: Date | null;
}

export interface TestOwner {
  readonly id: string;
  /**
   * The address the owner row ACTUALLY has — not the constant above.
   *
   * On a developer's database `bootstrap:owner` may already have created the
   * one owner under a real address, and this fixture then adopts that row
   * rather than making a second one it is not allowed to make. A caller that
   * looks the owner up by email (login.itest.ts does, because that is what a
   * person types) must use this, and assuming the constant is how three
   * two-factor tests failed the first time a real owner existed.
   */
  readonly email: string;
}

export async function ensureTestOwner(patch?: TestOwnerPatch): Promise<TestOwner> {
  return withRawActorContext(CTX, async (tx) => {
    await tx.execute(sql`
      INSERT INTO users (email, password_hash, role, status, display_name, email_verified_at)
      VALUES (${TEST_OWNER_EMAIL}, ${patch?.passwordHash ?? 'x'}, 'OWNER', 'ACTIVE',
              ${patch?.displayName ?? 'Owner'}, now())
      ON CONFLICT DO NOTHING
    `);

    const found = await tx.execute(sql`SELECT id, email::text AS email FROM users WHERE role = 'OWNER'`);
    const row = (found as unknown as Array<{ id: string; email: string }>)[0];
    if (!row) throw new Error('No owner row after ensureTestOwner — is migration 0041 applied?');

    // Applied as an update so the caller gets what it asked for even when the
    // row was created by an earlier file, or by bootstrap:owner.
    if (patch) {
      await tx.execute(sql`
        UPDATE users SET
          display_name = COALESCE(${patch.displayName ?? null}, display_name),
          password_hash = COALESCE(${patch.passwordHash ?? null}, password_hash),
          totp_secret_encrypted = ${patch.totpSecretEncrypted ?? null},
          totp_enabled_at = ${patch.totpEnabledAt?.toISOString() ?? null}::timestamptz,
          status = 'ACTIVE',
          failed_login_count = 0,
          locked_until = NULL,
          updated_at = now()
        WHERE id = ${row.id}::uuid
      `);
    }

    return { id: row.id, email: row.email };
  });
}
