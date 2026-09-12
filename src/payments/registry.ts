import 'server-only';
import { eq } from 'drizzle-orm';
import { paymentMethods } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';
import { getPublicSettings } from '@/platform/settings';
import type {
  PaymentContext, PaymentMethodConfig, PaymentProvider, PaymentMethodType,
} from './port';
import {
  ManualTransferProvider, UnconfiguredGatewayProvider, WhatsAppAssistProvider,
} from './providers';

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
