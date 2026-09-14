import 'server-only';
import { createTransport, type Transporter } from 'nodemailer';
import { ValidationError } from '@/lib/errors';

import type { EmailMessage, EmailPort } from './port';

/**
 * SMTP delivery.
 *
 * Configured from a single URL so that changing provider is one environment
 * variable rather than five, and so the credentials never appear in code.
 * `smtp://` on port 587 negotiates STARTTLS; `smtps://` is implicit TLS on
 * 465. Certificate verification is never disabled: a mail server whose
 * certificate cannot be verified is a mail server that may not be the one we
 * think we are handing a verification link to.
 *
 * THE URL IS PARSED HERE RATHER THAN HANDED STRAIGHT TO NODEMAILER.
 *
 * `createTransport(url, defaults)` takes MESSAGE defaults as its second
 * argument — not connection options. The timeouts below were originally passed
 * there, which type-checked under the old typings and did nothing at all: a
 * hung mail server would have held a registration request open indefinitely.
 * The upgrade to nodemailer 10 refused it and exposed the mistake. Building
 * the options object explicitly is what makes the timeouts real, and it is
 * also what makes them testable — see `parseSmtpUrl`.
 */

export interface SmtpConnection {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS. `smtps:` is true; `smtp:` upgrades via STARTTLS instead. */
  readonly secure: boolean;
  readonly auth?: { readonly user: string; readonly pass: string };
}

/**
 * Exported for its test. Credentials are percent-decoded, because a password
 * containing `@`, `:` or `/` MUST be encoded in a URL and would otherwise be
 * sent with the escapes still in it — an authentication failure that looks
 * like a wrong password and is very hard to see.
 */
export function parseSmtpUrl(raw: string): SmtpConnection {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('MAIL_TRANSPORT_URL is not a valid URL');
  }

  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    throw new ValidationError(
      `MAIL_TRANSPORT_URL must be smtp:// or smtps:// (got ${url.protocol}//)`,
    );
  }

  const secure = url.protocol === 'smtps:';
  const port = url.port ? Number(url.port) : (secure ? 465 : 587);

  if (!url.hostname) {
    throw new ValidationError('MAIL_TRANSPORT_URL names no host');
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new ValidationError(`MAIL_TRANSPORT_URL has an invalid port: ${url.port}`);
  }

  const user = url.username ? decodeURIComponent(url.username) : '';
  const pass = url.password ? decodeURIComponent(url.password) : '';

  return {
    host: url.hostname,
    port,
    secure,
    ...(user ? { auth: { user, pass } } : {}),
  };
}

export class SmtpEmail implements EmailPort {
  readonly name = 'smtp';
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(options: { readonly url: string; readonly from: string }) {
    this.from = options.from;
    const connection = parseSmtpUrl(options.url);

    this.transport = createTransport({
      host: connection.host,
      port: connection.port,
      secure: connection.secure,
      ...(connection.auth ? { auth: connection.auth } : {}),
      // Bounded so a hung mail server cannot hold a registration request open.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      // Never disabled. Stated rather than left to the default so that
      // "just turn this off to make it work" is a visible change here.
      tls: { rejectUnauthorized: true },
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
