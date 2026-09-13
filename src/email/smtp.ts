import 'server-only';
import { createTransport, type Transporter } from 'nodemailer';
import type { EmailMessage, EmailPort } from './port';

/**
 * SMTP delivery.
 *
 * Configured from a single URL so that changing provider is one environment
 * variable rather than five, and so the credentials never appear in code.
 * `smtp://` on port 587 negotiates STARTTLS; `smtps://` is implicit TLS on
 * 465. Certificate verification is never disabled: a mail server whose
 * certificate cannot be verified is a mail server that may not be the one we
 * think we are handing a password reset to.
 */
export class SmtpEmail implements EmailPort {
  readonly name = 'smtp';
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(options: { readonly url: string; readonly from: string }) {
    this.from = options.from;
    this.transport = createTransport(options.url, {
      // Bounded so a hung mail server cannot hold a registration request open.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
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
