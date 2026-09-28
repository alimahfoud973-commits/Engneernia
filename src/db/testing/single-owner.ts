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
/** The owner signs in with a username (Stage 6). */
export const TEST_OWNER_USERNAME = 'test-owner';
const CTX = { actorId: '00000000-0000-0000-0000-0000000000ff', actorRole: 'OWNER' };

export interface TestOwnerPatch {
  /** Some files assert on the name the owner acted under. */
  readonly displayName?: string;
  readonly passwordHash?: string;
}

export interface TestOwner {
  readonly id: string;
  /**
   * The username the owner row ACTUALLY has — not the constant above.
   *
   * On a developer's database `bootstrap:owner` may already have created the
   * one owner under another name, and this fixture then adopts that row
   * rather than making a second one it is not allowed to make. A caller that
   * signs the owner in (login.itest.ts) must use this; assuming the constant
   * is how three tests failed the first time a real owner existed.
   */
  readonly username: string;
  /** May be null: the owner needs no email since Stage 6. */
  readonly email: string | null;
}

export async function ensureTestOwner(patch?: TestOwnerPatch): Promise<TestOwner> {
  return withRawActorContext(CTX, async (tx) => {
    await tx.execute(sql`
      INSERT INTO users (username, email, password_hash, role, status, display_name)
      VALUES (${TEST_OWNER_USERNAME}, ${TEST_OWNER_EMAIL}, ${patch?.passwordHash ?? 'x'}, 'OWNER', 'ACTIVE',
              ${patch?.displayName ?? 'Owner'})
      ON CONFLICT DO NOTHING
    `);

    const found = await tx.execute(sql`
      SELECT id, username::text AS username, email::text AS email FROM users WHERE role = 'OWNER'
    `);
    const row = (found as unknown as Array<{ id: string; username: string; email: string | null }>)[0];
    if (!row) throw new Error('No owner row after ensureTestOwner — is migration 0041 applied?');

    // Applied as an update so the caller gets what it asked for even when the
    // row was created by an earlier file, or by bootstrap:owner.
    if (patch) {
      await tx.execute(sql`
        UPDATE users SET
          display_name = COALESCE(${patch.displayName ?? null}, display_name),
          password_hash = COALESCE(${patch.passwordHash ?? null}, password_hash),
          status = 'ACTIVE',
          failed_login_count = 0,
          locked_until = NULL,
          updated_at = now()
        WHERE id = ${row.id}::uuid
      `);
    }

    return { id: row.id, username: row.username, email: row.email };
  });
}
