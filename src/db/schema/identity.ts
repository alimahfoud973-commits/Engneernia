import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { citext, createdAt, updatedAt, utcTimestamp } from './columns';
import { userRoleEnum, userStatusEnum } from './enums';

/**
 * Users.
 *
 * The role lives HERE, in the database, and is read on every request from the
 * session join. It is never carried in a token, so a stolen or stale
 * credential cannot assert a role the database does not agree with, and the
 * owner can revoke access instantly by flipping `status`.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull().default('CUSTOMER'),
    status: userStatusEnum('status').notNull().default('PENDING'),

    displayName: text('display_name').notNull(),
    locale: text('locale').notNull().default('ar'),
    /** ISO-3166 alpha-2. Drives which payment methods are offered (phase P5). */
    countryCode: text('country_code'),

    emailVerifiedAt: utcTimestamp('email_verified_at'),

    /**
     * TOTP secret, encrypted at rest with CONFIG_ENCRYPTION_KEY.
     * Mandatory for OWNER (enforced in the login flow, not by the schema, so
     * that enabling it is a guided step rather than a lockout).
     */
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpEnabledAt: utcTimestamp('totp_enabled_at'),

    /** Brute-force controls. Reset on a successful authentication. */
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: utcTimestamp('locked_until'),
    lastLoginAt: utcTimestamp('last_login_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    index('users_role_status_idx').on(table.role, table.status),
  ],
);

/**
 * Sessions are DATABASE-backed, deliberately.
 *
 * Only a SHA-256 hash of the token is stored: a database leak does not hand
 * the attacker usable sessions. The raw token lives solely in an httpOnly,
 * SameSite=Lax, Secure cookie.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),

    /** Absolute expiry — a session dies at this point no matter how active. */
    expiresAt: utcTimestamp('expires_at').notNull(),
    /** Idle expiry is derived from this on each request. */
    lastUsedAt: utcTimestamp('last_used_at').notNull().defaultNow(),

    /** Set once the second factor has been satisfied for this session. */
    twoFactorVerifiedAt: utcTimestamp('two_factor_verified_at'),

    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),

    revokedAt: utcTimestamp('revoked_at'),
    revokedReason: text('revoked_reason'),

    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
    index('sessions_expiry_idx').on(table.expiresAt),
  ],
);

/**
 * Contributor profiles.
 *
 * A user having role CONTRIBUTOR is not sufficient to act as one: the profile
 * must exist and be active. Specification §32 and §46 — registering never
 * grants publication rights; the owner creates and authorises the contributor.
 */
export const contributors = pgTable(
  'contributors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /** Public URL segment, e.g. /contributors/ahmad-civil */
    publicSlug: text('public_slug').notNull(),
    /** Short stable code used in settlement references, e.g. SEP-2026-CIVIL */
    settlementCode: text('settlement_code').notNull(),

    displayName: text('display_name').notNull(),
    specialization: text('specialization'),
    bio: text('bio'),

    isActive: boolean('is_active').notNull().default(false),
    /** Specification §3.2: draft submission only if the owner enables it. */
    canSubmitDrafts: boolean('can_submit_drafts').notNull().default(false),

    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: utcTimestamp('approved_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('contributors_user_unique').on(table.userId),
    uniqueIndex('contributors_slug_unique').on(table.publicSlug),
    uniqueIndex('contributors_settlement_code_unique').on(table.settlementCode),
    index('contributors_active_idx').on(table.isActive),
  ],
);

/**
 * Granular permissions for a future delegated staff role.
 *
 * Empty by owner decision (OPEN-3: one privileged account). Present so that
 * delegation later does not require rewriting the policy layer.
 */
export const permissionGrants = pgTable(
  'permission_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('permission_grants_unique').on(table.userId, table.permission)],
);

export const usersRelations = relations(users, ({ one, many }) => ({
  contributor: one(contributors, { fields: [users.id], references: [contributors.userId] }),
  sessions: many(sessions),
}));

export const contributorsRelations = relations(contributors, ({ one }) => ({
  user: one(users, { fields: [contributors.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));
