import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Roles.
 *
 * Decision OPEN-3 resolved by the owner: there is ONE privileged account.
 * `ADMIN` is defined here but never assigned — it exists so that delegating a
 * subset of owner powers to staff later is a data change (a role assignment
 * plus permission grants), not a schema migration touching every RLS policy.
 */
export const userRoleEnum = pgEnum('user_role', ['OWNER', 'ADMIN', 'CONTRIBUTOR', 'CUSTOMER']);

export const userStatusEnum = pgEnum('user_status', ['ACTIVE', 'DISABLED', 'PENDING']);

/**
 * Audit actions. Every privileged or financial action in the specification
 * (§37) appears here. Later phases add their own values via migration; the
 * list is deliberately explicit rather than free text so that audit queries
 * and retention rules can rely on it.
 */
export const auditActionEnum = pgEnum('audit_action', [
  // identity — phase P1
  'USER_CREATED',
  'USER_UPDATED',
  'USER_DISABLED',
  'USER_ENABLED',
  'USER_ROLE_CHANGED',
  'USER_PASSWORD_CHANGED',
  'USER_TWO_FACTOR_ENABLED',
  'USER_TWO_FACTOR_DISABLED',
  'LOGIN_SUCCEEDED',
  'LOGIN_FAILED',
  'LOGIN_LOCKED_OUT',
  'LOGOUT',
  'SESSION_REVOKED',
  'CONTRIBUTOR_CREATED',
  'CONTRIBUTOR_UPDATED',
  'CONTRIBUTOR_ACTIVATED',
  'CONTRIBUTOR_DEACTIVATED',
  'CONTRIBUTOR_DRAFT_RIGHTS_CHANGED',
  // reserved for later phases so the enum does not churn per release
  'PRODUCT_CREATED',
  'PRODUCT_UPDATED',
  'PRODUCT_PUBLISHED',
  'PRODUCT_UNPUBLISHED',
  'PRODUCT_DELETED',
  'PRICE_CHANGED',
  'COMMISSION_CHANGED',
  'PAYMENT_METHOD_CHANGED',
  'PAYMENT_APPROVED',
  'PAYMENT_REJECTED',
  'REFUND_ISSUED',
  'SETTLEMENT_GENERATED',
  'SETTLEMENT_APPROVED',
  'SETTLEMENT_PAID',
  'SETTINGS_CHANGED',
]);
