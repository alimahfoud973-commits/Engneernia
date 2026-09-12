/**
 * Domain error taxonomy.
 *
 * Two rules govern error handling across the platform:
 *   1. Errors carry a stable `code` for the client; the message is for logs.
 *   2. Authorization failures surface as NOT_FOUND, never FORBIDDEN — telling a
 *      caller that a resource exists but is not theirs is an enumeration oracle.
 */

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'CONFLICT'
  | 'RULE_VIOLATION'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = Object.freeze({ ...details });
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('VALIDATION', message, 400, details);
  }
}

/** Also used for "exists but you may not see it". See rule 2 above. */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details: Record<string, unknown> = {}) {
    super('NOT_FOUND', message, 404, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message, 401);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('CONFLICT', message, 409, details);
  }
}

/**
 * A business invariant was violated — e.g. contributor shares not summing to
 * 100%, or an illegal order-state transition. These are bugs or bad input,
 * never something a user should be able to trigger by ordinary use.
 */
export class RuleViolationError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('RULE_VIOLATION', message, 422, details);
  }
}

/**
 * Thrown when a financial invariant fails (money created or destroyed).
 * This must never happen in production; it exists so that it fails loudly
 * in tests and CI rather than silently corrupting the ledger.
 */
export class MoneyInvariantError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('INTERNAL', `Money invariant violated: ${message}`, 500, details);
  }
}
