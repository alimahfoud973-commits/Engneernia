/**
 * ===========================================================================
 * PAYMENT PROVIDER PORT (specification §20, §25)
 * ===========================================================================
 * The rest of the platform knows exactly one thing about payment: that an
 * order became PAID, for an amount, at a time. Nothing in the catalogue, the
 * commission engine, the ledger or the settlement system imports anything
 * from this directory.
 *
 * That is what §25 asks for in practice: changing how money arrives must not
 * require rebuilding how money is accounted for.
 * ===========================================================================
 */

export type PaymentMethodType = 'MANUAL' | 'GATEWAY' | 'ASSISTED';

/** What the customer is shown once they pick a method. */
export type InitiationResult =
  | {
      /** Bank transfer, ShamCash: instructions, then the customer pays and uploads proof. */
      readonly kind: 'INSTRUCTIONS';
      readonly instructionsAr: string;
      readonly accountDetailsAr: string | null;
      readonly requiresProof: boolean;
      readonly reference: string;
    }
  | {
      /** WhatsApp: the platform hands the customer to a person (§23). */
      readonly kind: 'ASSISTED';
      readonly url: string;
      readonly messageAr: string;
    }
  | {
      /** A gateway takes over. None is configured — see decisions §2. */
      readonly kind: 'REDIRECT';
      readonly url: string;
    };

export type PaymentOutcome =
  | { readonly status: 'APPROVED'; readonly providerRef: string | null; readonly feeMinor: bigint }
  | { readonly status: 'REJECTED'; readonly reason: string }
  | { readonly status: 'PENDING' };

export interface PaymentContext {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly buyerCountry: string | null;
  readonly itemTitles: readonly string[];
}

/** The configuration row, as the provider sees it. Secrets are NOT here. */
export interface PaymentMethodConfig {
  readonly id: string;
  readonly code: string;
  readonly type: PaymentMethodType;
  readonly displayNameAr: string;
  readonly instructionsAr: string | null;
  readonly accountDetailsAr: string | null;
  readonly supportMessageAr: string | null;
  readonly requiresProof: boolean;
  readonly countries: readonly string[];
  readonly currencies: readonly string[];
  readonly minAmountMinor: bigint | null;
  readonly maxAmountMinor: bigint | null;
}

export interface PaymentProvider {
  readonly code: string;
  readonly type: PaymentMethodType;

  /**
   * Provider-specific availability, on top of the data-driven country,
   * currency and amount checks the registry already applies.
   *
   * A provider that cannot actually serve a customer must say so HERE rather
   * than fail at the end of checkout — §22 is explicit that a method must not
   * be promised merely because it exists in the interface.
   */
  supports(config: PaymentMethodConfig, context: PaymentContext): boolean;

  initiate(config: PaymentMethodConfig, context: PaymentContext): Promise<InitiationResult>;

  /** MANUAL: the owner reviews the uploaded proof and decides. */
  reviewProof?(input: {
    approve: boolean;
    providerRef?: string | null;
    reason?: string | null;
  }): Promise<PaymentOutcome>;

  /** GATEWAY: a verified callback resolves the payment. */
  handleCallback?(payload: unknown, signature: string | null): Promise<PaymentOutcome>;
}
