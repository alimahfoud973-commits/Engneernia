import 'server-only';
import { getSql } from '@/db';
import { withRawActorContext } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { GUEST } from '@/authz/actor';
import { hashLinkToken } from './crypto';

/**
 * Redeeming a verification link.
 *
 * The whole decision is one call into `app_consume_email_verification`, which
 * marks the token spent and flips the account to ACTIVE in a single statement.
 * Nothing is decided here that the database could disagree with, and the
 * single-use guarantee is not a check in this file — a double-clicked link
 * cannot be redeemed twice because the second UPDATE matches no row.
 */

export type VerificationOutcome =
  | 'VERIFIED'
  | 'ALREADY_VERIFIED'
  | 'EXPIRED_OR_SPENT'
  | 'INVALID';

export async function consumeVerificationToken(input: {
  readonly rawToken: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}): Promise<VerificationOutcome> {
  const token = input.rawToken.trim();
  if (token.length === 0) return 'INVALID';

  const rows = await getSql()<Array<{ user_id: string | null; outcome: VerificationOutcome }>>`
    SELECT * FROM app_consume_email_verification(${hashLinkToken(token)})
  `;

  const row = rows[0];
  if (!row) return 'INVALID';

  // Only a verification that actually changed something is worth a log line.
  if (row.outcome === 'VERIFIED' && row.user_id) {
    await withRawActorContext({ actorId: '', actorRole: 'GUEST' }, (tx) =>
      recordAudit(tx, GUEST, {
        action: 'USER_EMAIL_VERIFIED',
        entityType: 'user',
        entityId: row.user_id,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      }),
    );
  }

  return row.outcome;
}
