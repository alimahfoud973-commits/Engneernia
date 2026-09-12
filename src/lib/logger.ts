import 'server-only';
import pino from 'pino';

/**
 * Structured logging.
 *
 * The redaction list is a security control, not a convenience: audit and
 * financial paths log rich context, and none of it may include a credential,
 * a signed URL, or a payment secret. Add to this list whenever a new sensitive
 * field name enters the codebase.
 */
const REDACTED_PATHS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'sessionToken',
  'secret',
  'signedUrl',
  'authorization',
  'cookie',
  'providerConfig',
  '*.password',
  '*.passwordHash',
  '*.secret',
  '*.token',
  'req.headers.authorization',
  'req.headers.cookie',
];

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  base: { service: 'engineering-marketplace' },
  ...(isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
});

/** Child logger tagged with a correlation id, for tracing one request end to end. */
export function requestLogger(correlationId: string) {
  return logger.child({ correlationId });
}
