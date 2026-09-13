import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { withRawActorContext } from '@/db/actor-context';
import { closeDb } from '@/db';
import { users } from '@/db/schema';
import { ensureTestOwner } from '@/db/testing/single-owner';

/**
 * ONE OWNER, AND THE DATABASE IS THE ONE SAYING SO (owner decision on OPEN-22).
 *
 * Specification §2.1 has always said one owner, but until migration 0041 the
 * only thing enforcing it was a check inside `scripts/bootstrap-owner.ts`.
 * These tests exist because a rule that lives in a script is a rule that holds
 * only for code that remembers to ask — so every case below goes around the
 * application entirely and writes SQL directly, including as a superuser.
 */

const CTX = { actorId: randomUUID(), actorRole: 'OWNER' };
const suffix = Date.now();
const candidate = randomUUID();
const disabled = randomUUID();

let ownerId = '';

function privileged() {
  const url = process.env.DATABASE_SUPERUSER_URL ?? process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_SUPERUSER_URL or DATABASE_MIGRATION_URL must be set');
  return postgres(url, { max: 1 });
}

beforeAll(async () => {
  ownerId = await ensureTestOwner({ displayName: 'Owner' });
  await withRawActorContext(CTX, async (tx) => {
    await tx.insert(users).values([
      {
        id: candidate, email: `heir+${suffix}@test.local`, passwordHash: 'x',
        role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Heir',
      },
      {
        id: disabled, email: `disabled-heir+${suffix}@test.local`, passwordHash: 'x',
        role: 'CUSTOMER', status: 'DISABLED', displayName: 'Disabled Heir',
      },
    ]);
  });
});

afterAll(async () => {
  // Leave the platform as it was found: one owner, the shared fixture row.
  const db = privileged();
  try {
    await db`SELECT app_transfer_ownership(${ownerId}::uuid)`;
    await db`DELETE FROM users WHERE id IN (${candidate}::uuid, ${disabled}::uuid)`;
  } finally {
    await db.end();
  }
  await closeDb();
});

async function ownerCount(): Promise<number> {
  const db = privileged();
  try {
    const rows = await db<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM users WHERE role = 'OWNER'
    `;
    return rows[0]?.count ?? 0;
  } finally {
    await db.end();
  }
}

describe('a second owner cannot be created', () => {
  it('refuses an INSERT of a second owner — to a superuser, not just to the app', async () => {
    const db = privileged();
    try {
      await expect(db`
        INSERT INTO users (email, password_hash, role, status, display_name)
        VALUES (${`second+${suffix}@test.local`}, 'x', 'OWNER', 'ACTIVE', 'Second Owner')
      `).rejects.toThrow(/users_single_owner/);
    } finally {
      await db.end();
    }
    expect(await ownerCount()).toBe(1);
  });

  it('refuses promoting an existing user by UPDATE', async () => {
    const db = privileged();
    try {
      await expect(
        db`UPDATE users SET role = 'OWNER' WHERE id = ${candidate}::uuid`,
      ).rejects.toThrow(/users_single_owner/);
    } finally {
      await db.end();
    }
    expect(await ownerCount()).toBe(1);
  });

  it('leaves every other role alone — the index is partial, not a cap on users', async () => {
    const db = privileged();
    try {
      const extra = randomUUID();
      await db`
        INSERT INTO users (id, email, password_hash, role, status, display_name)
        VALUES (${extra}::uuid, ${`many+${suffix}@test.local`}, 'x', 'CONTRIBUTOR', 'ACTIVE', 'Another')
      `;
      const rows = await db<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM users WHERE role = 'CONTRIBUTOR'
      `;
      expect(rows[0]!.count).toBeGreaterThan(0);
      await db`DELETE FROM users WHERE id = ${extra}::uuid`;
    } finally {
      await db.end();
    }
  });
});

describe('handover', () => {
  /**
   * The cost of the constraint is that no standby owner account can exist. It
   * is survivable only because ownership can still move — so this is the test
   * that matters most: if it fails, losing the owner's credentials means
   * losing the platform.
   */
  it('moves the platform in one transaction, never leaving zero or two owners', async () => {
    const db = privileged();
    try {
      const rows = await db<Array<{ previous_owner: string; new_owner: string }>>`
        SELECT * FROM app_transfer_ownership(${candidate}::uuid)
      `;
      expect(rows[0]?.previous_owner).toBe(ownerId);
      expect(rows[0]?.new_owner).toBe(candidate);

      const after = await db<Array<{ id: string; role: string }>>`
        SELECT id, role::text AS role FROM users WHERE id IN (${ownerId}::uuid, ${candidate}::uuid)
      `;
      const byId = new Map(after.map((r) => [r.id, r.role]));
      expect(byId.get(candidate)).toBe('OWNER');
      // Demoted, not disabled: they keep the account and whatever they bought.
      expect(byId.get(ownerId)).toBe('CUSTOMER');
    } finally {
      await db.end();
    }
    expect(await ownerCount()).toBe(1);
  });

  it('records both halves in the audit log, in the same transaction', async () => {
    const db = privileged();
    try {
      const rows = await db<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM audit_logs
         WHERE action = 'USER_ROLE_CHANGED'
           -- entity_id is text, not uuid: the append-only trail deliberately
           -- carries ids without foreign keys, so deleting an account stays
           -- possible (see CLAUDE.md on append-only tables).
           AND entity_id IN (${ownerId}, ${candidate})
      `;
      expect(rows[0]!.count).toBeGreaterThanOrEqual(2);
    } finally {
      await db.end();
    }
  });

  it('is a no-op when the platform is handed to whoever already has it', async () => {
    const db = privileged();
    try {
      const rows = await db<Array<{ previous_owner: string; new_owner: string }>>`
        SELECT * FROM app_transfer_ownership(${candidate}::uuid)
      `;
      expect(rows[0]?.new_owner).toBe(candidate);
    } finally {
      await db.end();
    }
    expect(await ownerCount()).toBe(1);
  });

  it('refuses an account that cannot sign in', async () => {
    const db = privileged();
    try {
      await expect(
        db`SELECT app_transfer_ownership(${disabled}::uuid)`,
      ).rejects.toThrow(/DISABLED|not ACTIVE/i);
    } finally {
      await db.end();
    }
    expect(await ownerCount()).toBe(1);
  });

  it('refuses a user that does not exist', async () => {
    const db = privileged();
    try {
      await expect(
        db`SELECT app_transfer_ownership(${randomUUID()}::uuid)`,
      ).rejects.toThrow(/No user/i);
    } finally {
      await db.end();
    }
    expect(await ownerCount()).toBe(1);
  });
});

describe('the application role cannot reach it', () => {
  it('has no execute permission on app_transfer_ownership', async () => {
    let message = '';
    try {
      await withRawActorContext(CTX, (tx) =>
        tx.execute(sql`SELECT app_transfer_ownership(${candidate}::uuid)`),
      );
    } catch (error) {
      const cause = (error as { cause?: { message?: string } }).cause;
      message = `${(error as Error).message} ${cause?.message ?? ''}`;
    }
    expect(message).toMatch(/permission denied/i);
  });
});
