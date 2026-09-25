import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { paymentMethods } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';
import { getPublicSettings } from '@/platform/settings';
import type {
  PaymentContext, PaymentMethodConfig, PaymentProvider, PaymentMethodType,
} from './port';
import {
  ManualTransferProvider, UnconfiguredGatewayProvider, WhatsAppAssistProvider, manualMethodGaps,
} from './providers';
import {
  DEFAULT_WHATSAPP_TEMPLATE, fillWhatsappTemplate, normalizeWhatsappNumber, whatsappLink,
} from './whatsapp';

/**
 * ===========================================================================
 * WHICH METHODS A CUSTOMER MAY ACTUALLY USE (specification §22)
 * ===========================================================================
 * Availability is DATA — country, currency and amount bounds are columns on
 * the method row, editable by the owner without a deploy. The provider adds
 * only rules it alone can know.
 *
 * Resolution runs server-side at checkout render AND again at order placement.
 * A method disabled between those two moments is refused on submit; the
 * browser's copy of the list is never trusted.
 * ===========================================================================
 */

export interface AvailableMethod {
  readonly config: PaymentMethodConfig;
  readonly provider: PaymentProvider;
}

function providerFor(type: PaymentMethodType, whatsappPhone: string): PaymentProvider {
  switch (type) {
    case 'MANUAL':
      return new ManualTransferProvider();
    case 'ASSISTED':
      return new WhatsAppAssistProvider(whatsappPhone);
    case 'GATEWAY':
      return new UnconfiguredGatewayProvider();
  }
}

function toConfig(row: typeof paymentMethods.$inferSelect): PaymentMethodConfig {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    displayNameAr: row.displayNameAr,
    instructionsAr: row.instructionsAr,
    accountDetailsAr: row.accountDetailsAr,
    supportMessageAr: row.supportMessageAr,
    requiresProof: row.requiresProof,
    countries: row.countries ?? [],
    currencies: row.currencies ?? [],
    minAmountMinor: row.minAmountMinor,
    maxAmountMinor: row.maxAmountMinor,
  };
}

/** An empty list on the row means "no restriction on this dimension". */
function allowsCountry(config: PaymentMethodConfig, country: string | null): boolean {
  if (config.countries.length === 0) return true;
  if (!country) return false;
  return config.countries.includes(country.toUpperCase());
}

function allowsCurrency(config: PaymentMethodConfig, currency: string): boolean {
  if (config.currencies.length === 0) return true;
  return config.currencies.includes(currency.toUpperCase());
}

function allowsAmount(config: PaymentMethodConfig, amountMinor: bigint): boolean {
  if (config.minAmountMinor !== null && amountMinor < config.minAmountMinor) return false;
  if (config.maxAmountMinor !== null && amountMinor > config.maxAmountMinor) return false;
  return true;
}

export function isMethodAvailable(
  config: PaymentMethodConfig,
  provider: PaymentProvider,
  context: PaymentContext,
): boolean {
  return (
    allowsCountry(config, context.buyerCountry) &&
    allowsCurrency(config, context.currency) &&
    allowsAmount(config, context.amountMinor) &&
    provider.supports(config, context)
  );
}

/**
 * The methods this customer may use for this order, in the owner's order.
 *
 * RLS has already removed inactive methods, so an inactive one cannot be
 * resolved even by naming its id.
 */
export async function availableMethods(
  tx: Transaction,
  context: PaymentContext,
): Promise<readonly AvailableMethod[]> {
  const settings = await getPublicSettings();

  const rows = await tx
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.isActive, true))
    .orderBy(paymentMethods.sortOrder);

  return rows
    .map((row) => {
      const config = toConfig(row);
      return { config, provider: providerFor(config.type, settings.whatsapp) };
    })
    .filter(({ config, provider }) => isMethodAvailable(config, provider, context));
}

/**
 * Why an ACTIVE method is still not offered to anyone — empty when nothing
 * but a customer's country, currency or amount can keep it back.
 *
 * For the owner's screen (F3): the same rules `availableMethods` applies
 * through each provider's `supports`, put into words. A manual method lists
 * exactly what is missing; the other two types depend on things outside the
 * row (a WhatsApp number in settings, a gateway that does not exist).
 */
export function methodGaps(config: PaymentMethodConfig, whatsappPhone: string): readonly string[] {
  switch (config.type) {
    case 'MANUAL':
      return manualMethodGaps(config).map((gap) => `ينقصها: ${gap}`);
    case 'ASSISTED':
      return new WhatsAppAssistProvider(whatsappPhone).supports()
        ? []
        : ['لم يُضبط رقم واتساب في إعدادات المنصة'];
    case 'GATEWAY':
      return ['لا توجد بوابة دفع إلكترونية مُعدّة'];
  }
}

/**
 * "Having trouble with payment? Contact us on WhatsApp" (specification §23 —
 * W2): the permanent fallback, as a ready link for this order — or null when
 * the owner has set no usable number, so nothing is promised that cannot be
 * reached.
 *
 * The number is today's setting, never one copied onto the order: WhatsApp is
 * how a customer reaches the platform, and an old order should reach whoever
 * answers now. The message is the owner's own template on the active
 * WhatsApp method when there is one.
 */
export async function whatsappHelpLink(
  tx: Transaction,
  context: PaymentContext,
): Promise<string | null> {
  const number = normalizeWhatsappNumber((await getPublicSettings()).whatsapp);
  if (number === null) return null;

  const [assisted] = await tx
    .select({ template: paymentMethods.supportMessageAr })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.type, 'ASSISTED'), eq(paymentMethods.isActive, true)))
    .orderBy(asc(paymentMethods.sortOrder))
    .limit(1);

  const message = fillWhatsappTemplate(assisted?.template ?? DEFAULT_WHATSAPP_TEMPLATE, {
    items: context.itemTitles,
    order: context.orderNumber,
    amountMinor: context.amountMinor,
    currency: context.currency,
  });
  return whatsappLink(number, message);
}

/**
 * Resolve one method for an order that is being placed.
 *
 * Returns null when the method is unknown, inactive, or not available for
 * this order — the three cases the caller must treat identically, because
 * distinguishing them tells a probing client which methods exist.
 */
export async function resolveMethod(
  tx: Transaction,
  methodId: string,
  context: PaymentContext,
): Promise<AvailableMethod | null> {
  const methods = await availableMethods(tx, context);
  return methods.find((m) => m.config.id === methodId) ?? null;
}

export { providerFor, toConfig };
