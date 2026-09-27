import { eq } from 'drizzle-orm';
import { products, productVersions } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';

/**
 * Insert fixture products, each with a version 1 that is its version on sale.
 *
 * Since migration 0059 a sale names the version it sells, and `createOrder`
 * refuses a product with no version on sale — which no product reaches in the
 * application, because a version is created by the upload that publishing
 * requires. Fixtures that insert a PUBLISHED row directly skip that upload;
 * this gives them the version the upload would have, and nothing else (no
 * file rows: suites that need files attach their own).
 */
export async function insertProductsWithVersion(
  tx: Transaction,
  values: typeof products.$inferInsert | ReadonlyArray<typeof products.$inferInsert>,
): Promise<void> {
  const rows = Array.isArray(values) ? values : [values as typeof products.$inferInsert];
  if (rows.length === 0) return;
  const inserted = await tx.insert(products).values([...rows]).returning({ id: products.id });
  for (const { id } of inserted) {
    const [version] = await tx.insert(productVersions)
      .values({ productId: id, versionNo: 1, activatedAt: new Date() })
      .returning({ id: productVersions.id });
    await tx.update(products).set({ currentVersionId: version!.id }).where(eq(products.id, id));
  }
}
