import type {
  InitiationResult, PaymentContext, PaymentMethodConfig, PaymentOutcome, PaymentProvider,
} from './port';
import {
  DEFAULT_WHATSAPP_TEMPLATE, fillWhatsappTemplate, normalizeWhatsappNumber, whatsappLink,
} from './whatsapp';

/**
 * What a manual method still lacks before a customer can be sent to pay by
 * it — empty when it is complete (Stage 2 audit, F3).
 *
 * Both are required: instructions say what to do, account details say where
 * the money goes. Without the second a customer is sent to transfer money to
 * nobody — which is what the seeded placeholder "يُعبّئها المالك من لوحة
 * الإدارة" did, shown to buyers as if it were an account. The owner's screen
 * lists the same gaps, so "not offered" never has to be guessed at.
 */
export function manualMethodGaps(
  config: Pick<PaymentMethodConfig, 'instructionsAr' | 'accountDetailsAr'>,
): readonly string[] {
  const gaps: string[] = [];
  if ((config.instructionsAr ?? '').trim() === '') gaps.push('تعليمات الدفع');
  if ((config.accountDetailsAr ?? '').trim() === '') gaps.push('بيانات الحساب');
  return gaps;
}

/**
 * Manual transfer — bank transfer, ShamCash, any local method.
 *
 * This is ONE adapter serving every manually-verified method: they differ
 * only in the instructions and account details the owner writes on the row,
 * not in behaviour. Adding "ShamCash" is a row, not a class.
 */
export class ManualTransferProvider implements PaymentProvider {
  readonly code = 'manual';
  readonly type = 'MANUAL' as const;

  supports(config: PaymentMethodConfig): boolean {
    // Offered only when complete: instructions AND an account to pay into.
    return manualMethodGaps(config).length === 0;
  }

  async initiate(
    config: PaymentMethodConfig,
    context: PaymentContext,
  ): Promise<InitiationResult> {
    return {
      kind: 'INSTRUCTIONS',
      instructionsAr: config.instructionsAr ?? '',
      accountDetailsAr: config.accountDetailsAr,
      requiresProof: config.requiresProof,
      // The customer writes this on the transfer so the owner can match it.
      reference: context.orderNumber,
    };
  }

  async reviewProof(input: {
    approve: boolean;
    providerRef?: string | null;
    reason?: string | null;
  }): Promise<PaymentOutcome> {
    if (input.approve) {
      return {
        status: 'APPROVED',
        providerRef: input.providerRef ?? null,
        // Transfer fees are recorded on the payment, not deducted from the
        // engineer's share. See OPEN-2 — undecided, so nothing is assumed.
        feeMinor: 0n,
      };
    }
    return { status: 'REJECTED', reason: input.reason ?? 'لم يُقبل إثبات الدفع' };
  }
}

/**
 * WhatsApp assistance (specification §23).
 *
 * The permanent fallback for a customer who cannot complete any available
 * method. It does not take money — it hands the customer to a person, and the
 * order waits.
 */
export class WhatsAppAssistProvider implements PaymentProvider {
  readonly code = 'whatsapp';
  readonly type = 'ASSISTED' as const;

  /** The number as wa.me needs it, or null when none usable is set (W2). */
  private readonly phone: string | null;

  constructor(phone: string) {
    this.phone = normalizeWhatsappNumber(phone);
  }

  supports(): boolean {
    // Offered only when the owner has set a number a chat can reach — a
    // local "0933…" or a word in the setting would build a link to nobody.
    return this.phone !== null;
  }

  async initiate(
    config: PaymentMethodConfig,
    context: PaymentContext,
  ): Promise<InitiationResult> {
    if (this.phone === null) {
      throw new Error('WhatsApp assistance has no usable number; supports() should have refused it.');
    }
    const messageAr = fillWhatsappTemplate(config.supportMessageAr ?? DEFAULT_WHATSAPP_TEMPLATE, {
      items: context.itemTitles,
      order: context.orderNumber,
      amountMinor: context.amountMinor,
      currency: context.currency,
    });

    return { kind: 'ASSISTED', url: whatsappLink(this.phone, messageAr), messageAr };
  }
}

/**
 * Gateway skeleton.
 *
 * Deliberately inert. Decisions §2: the merchant operates from Syria, and no
 * international gateway is assumed to be available. The adapter exists so
 * that enabling one later is a configuration change and a callback
 * implementation — not a rewrite of checkout — and it refuses to initiate
 * rather than presenting a payment button that cannot complete (§22).
 */
export class UnconfiguredGatewayProvider implements PaymentProvider {
  readonly code = 'gateway';
  readonly type = 'GATEWAY' as const;

  supports(): boolean {
    return false;
  }

  async initiate(): Promise<InitiationResult> {
    throw new Error(
      'No payment gateway is configured. Enabling one requires a merchant account and a callback implementation.',
    );
  }
}
