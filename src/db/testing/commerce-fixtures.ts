import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { insertProductsWithVersion } from '@/db/testing/product-versions';
import { withFinancialPurge } from '@/db/testing/financial-purge';
import {
  commissionAgreements, contributors, disciplines, entitlements, orders, paymentMethods,
  payments, productContributors, productPrices, products, settings, users,
} from '@/db/schema';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * ONE PURCHASE WORLD FOR THE STAGE 7 PAYMENT-FLOW TESTS
 * ===========================================================================
 * A few buyers, one engineer on a percentage agreement, paid products, a free
 * one, and three methods: two manual transfers that take a receipt and
 * WhatsApp assistance (INITIATED, no receipt). Each test file builds its own
 * world with its own suffix and removes it afterwards; the invoices it issued
 * stay, because invoices are append-only even for a superuser (OPEN-9).
 * ===========================================================================
 */

export interface CommerceWorld {
  readonly suffix: string;
  readonly owner: Actor;
  readonly ownerRaw: { actorId: string; actorRole: string };
  readonly buyers: readonly Actor[];
  readonly buyerIds: readonly string[];
  readonly engineer: Actor;
  readonly contributorId: string;
  readonly products: Readonly<Record<string, { id: string; slug: string }>>;
  readonly methods: { readonly bank: string; readonly wallet: string; readonly whatsapp: string };
  readonly cleanup: () => Promise<void>;
}

const base = { kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's' } as const;

export const customerActor = (userId: string): Actor => ({
  ...base, userId, role: 'CUSTOMER', contributorId: null, contributorActive: false,
});

/** A real, minimal PNG: the proof path inspects the bytes, not the name. */
export function pngBytes(): Uint8Array {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...new Array(12).fill(200)])));
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

export async function buildCommerceWorld(input: {
  prefix: string;
  buyers: number;
  /** Product key → price in minor units (0 = free). */
  prices: Readonly<Record<string, bigint>>;
}): Promise<CommerceWorld> {
  const suffix = `${input.prefix}-${Date.now()}`;
  const ownerId = (await ensureTestOwner({ displayName: 'Owner' })).id;
  const ownerRaw = { actorId: ownerId, actorRole: 'OWNER' };
  const owner: Actor = { ...base, userId: ownerId, role: 'OWNER', contributorId: null, contributorActive: false };

  const buyerIds = Array.from({ length: input.buyers }, () => randomUUID());
  const engineerUserId = randomUUID();
  const contributorId = randomUUID();
  const disciplineId = randomUUID();
  const productEntries = Object.entries(input.prices).map(([key, price]) => ({
    key, price, id: randomUUID(), slug: `${suffix}-${key}`.toLowerCase(),
  }));
  const methods = { bank: randomUUID(), wallet: randomUUID(), whatsapp: randomUUID() };
  let whatsappBefore = '""';

  await withRawActorContext(ownerRaw, async (tx) => {
    const [w] = await tx.select({ v: sql<string>`${settings.value}::text` }).from(settings)
      .where(eq(settings.key, 'support.whatsapp'));
    whatsappBefore = w?.v ?? '""';
    await tx.execute(sql`UPDATE settings SET value = '"963933123456"'::jsonb WHERE key = 'support.whatsapp'`);

    await tx.insert(users).values(buyerIds.map((id, i) => ({
      id, email: `${suffix}-b${i}@test.local`, role: 'CUSTOMER' as const, status: 'ACTIVE' as const,
      displayName: `Buyer ${i}`, countryCode: 'SY',
    })));
    await tx.insert(users).values({
      id: engineerUserId, email: `${suffix}-eng@test.local`, role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer',
    });
    await tx.insert(contributors).values({
      id: contributorId, userId: engineerUserId, publicSlug: `${suffix}-eng`.toLowerCase(),
      settlementCode: `S7${Date.now()}${Math.floor(Math.random() * 1000)}`, displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({
      id: disciplineId, slug: `${suffix}-disc`.toLowerCase(), nameAr: 'تخصص', nameEn: 'T', sortOrder: 90,
    });
    const published = {
      disciplineId, fileType: 'PDF' as const, status: 'PUBLISHED' as const, currency: 'USD', publishedAt: new Date(),
    };
    await insertProductsWithVersion(tx, productEntries.map((p) => ({
      id: p.id, slug: p.slug, titleAr: `منتج ${p.key}`, ...published,
    })));
    await tx.insert(productContributors).values(productEntries.map((p) => ({
      productId: p.id, contributorId, shareBp: 10000,
    })));
    await tx.insert(productPrices).values(productEntries.map((p) => ({
      productId: p.id, amountMinor: p.price, currency: 'USD',
    })));
    await tx.insert(commissionAgreements).values({
      contributorId, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ownerId,
    });
    await tx.insert(paymentMethods).values([
      {
        id: methods.bank, code: `${suffix}-bank`.toLowerCase(), type: 'MANUAL', displayNameAr: 'تحويل بنكي',
        instructionsAr: 'حوّل المبلغ', accountDetailsAr: 'IBAN TEST', requiresProof: true,
        countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
      },
      {
        id: methods.wallet, code: `${suffix}-wallet`.toLowerCase(), type: 'MANUAL', displayNameAr: 'محفظة',
        instructionsAr: 'أرسل المبلغ', accountDetailsAr: 'WALLET TEST', requiresProof: true,
        countries: [], currencies: ['USD'], isActive: true, sortOrder: 2,
      },
      {
        id: methods.whatsapp, code: `${suffix}-wa`.toLowerCase(), type: 'ASSISTED', displayNameAr: 'واتساب',
        instructionsAr: 'سيتم تحويلك', requiresProof: false,
        countries: [], currencies: [], isActive: true, sortOrder: 9,
      },
    ]);
  });

  const cleanup = async () => {
    await withRawActorContext(ownerRaw, (tx) =>
      tx.execute(sql`UPDATE settings SET value = ${whatsappBefore}::jsonb WHERE key = 'support.whatsapp'`));
    await withFinancialPurge(async (tx) => {
      const productIds = productEntries.map((p) => p.id);
      await tx.delete(entitlements).where(inArray(entitlements.customerId, buyerIds));
      await tx.delete(orders).where(inArray(orders.customerId, buyerIds));
      await tx.delete(paymentMethods).where(inArray(paymentMethods.id, Object.values(methods)));
      await tx.delete(commissionAgreements).where(eq(commissionAgreements.contributorId, contributorId));
      await tx.delete(productContributors).where(inArray(productContributors.productId, productIds));
      await tx.delete(productPrices).where(inArray(productPrices.productId, productIds));
      await tx.delete(products).where(inArray(products.id, productIds));
      await tx.delete(disciplines).where(eq(disciplines.id, disciplineId));
      await tx.delete(contributors).where(eq(contributors.id, contributorId));
      await tx.delete(users).where(inArray(users.id, [...buyerIds, engineerUserId]));
    });
  };

  return {
    suffix,
    owner,
    ownerRaw,
    buyers: buyerIds.map(customerActor),
    buyerIds,
    engineer: { ...base, userId: engineerUserId, role: 'CONTRIBUTOR', contributorId, contributorActive: true },
    contributorId,
    products: Object.fromEntries(productEntries.map((p) => [p.key, { id: p.id, slug: p.slug }])),
    methods,
    cleanup,
  };
}

/** Every payment of an order, oldest first, read as the owner. */
export function paymentsOfOrder(world: CommerceWorld, orderId: string) {
  return withRawActorContext(world.ownerRaw, (tx) =>
    tx.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(payments.createdAt, payments.id));
}

/** The order's status, read as the owner. */
export async function orderStatusOf(world: CommerceWorld, orderId: string): Promise<string> {
  const [row] = await withRawActorContext(world.ownerRaw, (tx) =>
    tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)));
  return row!.status;
}
