/**
 * ===========================================================================
 * OUTBOUND EMAIL (owner decision on OPEN-23 — self-registration)
 * ===========================================================================
 * One port, two adapters, chosen by configuration — the same shape as the
 * storage port in `src/media/storage`, and for the same reason: the platform
 * is operated from Syria, where a mail provider that works today may have to
 * be replaced at short notice. Nothing above this interface knows which one
 * is in use.
 *
 * THE INVARIANT EVERY ADAPTER MUST UPHOLD: a failure to deliver is REPORTED,
 * never swallowed. A verification email that silently vanishes turns into a
 * customer who cannot buy and an owner who cannot see why — which is worse
 * than a registration that visibly fails and can be retried.
 * ===========================================================================
 */

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  /** Always sent. A recipient whose client refuses HTML still reads the mail. */
  readonly text: string;
  readonly html: string;
}

export interface EmailPort {
  readonly name: string;
  /** Rejects on failure. Callers decide whether that failure is fatal. */
  send(message: EmailMessage): Promise<void>;
}
