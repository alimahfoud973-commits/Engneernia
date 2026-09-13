import 'server-only';
import { logger } from '@/lib/logger';
import type { EmailMessage, EmailPort } from './port';

/**
 * Development adapter: writes the message to the log instead of sending it.
 *
 * It logs the full text body ON PURPOSE. Local work needs the verification
 * link, and the alternative — a developer guessing at tokens in the database —
 * is how people end up adding a "skip verification" flag that later ships.
 *
 * `getEmail()` refuses to select this adapter in production.
 */
export class LogEmail implements EmailPort {
  readonly name = 'log';

  async send(message: EmailMessage): Promise<void> {
    logger.info(
      { to: message.to, subject: message.subject, body: message.text },
      'Email not sent — log transport is configured',
    );
  }
}
