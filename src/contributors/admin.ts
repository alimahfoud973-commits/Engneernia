import 'server-only';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  commissionAgreements, contributors, disciplines, productContributors,
  products, users,
} from '@/db/schema';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { isOwner, type Actor } from '@/authz/actor';
import { NotFoundError, RuleViolationError, ValidationError } from '@/lib/errors';
import { LEDGER_ACCOUNTS } from '@/ledger/accounts';
import type { CommissionModel } from '@/lib/money/commission';

/**
 * ===========================================================================
 * THE OWNER'S ENGINEERS SCREEN (§19, §32, §46)
 * ===========================================================================
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO, because it already exists:
 *
 *   - It does not SET commission rates. `src/finance/commissions.ts` does,
 *     through `setCommissionAgreement`, which closes the open row and opens a
 *     new one so past sales keep the rate they were booked at. A second write
 *     path for the same fact is a second chance to get the versioning wrong.
 *     This file READS the rate in force and links to that screen.
 *   - It does not create, publish or delete products. `src/catalog/` does.
 *   - It does not compute a balance of its own. The ledger is the only place a
 *     balance exists (P6), and the query below sums it exactly as
 *     `outstandingPayables` does, from the same account code.
 *
 * WHAT IT ADDS: the owner's view OF AN ENGINEER — who they are, which
 * discipline, active or not, what they have on the platform, what it sold,
 * what they are owed and what the platform kept.
 *
 * AND ONE THING IT WITHHOLDS, from everyone but the owner: all of it. Every
 * function here refuses a non-owner outright rather than narrowing its result
 * (CLAUDE.md rule: hiding in the UI is not protection, and a screen that
 * half-works is harder to notice than one that does not open). Underneath,
 * `product_contributors` has been owner-only since migration 0049 and
 * `order_item_contributors` resolves one engineer's own row — so even if this
 * guard were deleted, an engineer would get an empty page rather than a
 * colleague's earnings. The guard is the first of the four layers, not the
 * only one.
 * ===========================================================================
 */

function requireOwner(actor: Actor, what: string): void {
  if (!isOwner(actor)) {
    throw new RuleViolationError(`${what} من صلاحية مالك المنصة وحده`);
  }
}

export interface EngineerRosterRow {
  readonly contributorId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly publicSlug: string;
  readonly settlementCode: string;
  readonly disciplineId: string | null;
  readonly disciplineNameAr: string | null;
  readonly specialization: string | null;
  readonly isActive: boolean;
  readonly canSubmitDrafts: boolean;
  readonly productsTotal: number;
  readonly productsPublished: number;
  /** The rate in force, for display. Null when this engineer has no terms. */
  readonly model: CommissionModel | null;
  readonly engineerBp: number | null;
  /** Sales, per currency. Empty when they have sold nothing. */
  readonly sales: readonly EngineerSalesRow[];
  /** What the platform still owes them, per currency, from the LEDGER. */
  readonly dues: readonly EngineerDueRow[];
}

export interface EngineerSalesRow {
  readonly currency: string;
  readonly unitsSold: number;
  /**
   * THIS ENGINEER'S OWN SLICE of the sales value — not the products' prices.
   * On a shared product the price is mostly a colleague's, and an owner
   * comparing engineers on it is comparing the wrong number.
   */
  readonly sliceMinor: bigint;
  readonly engineerMinor: bigint;
  /** What the platform took FROM THIS ENGINEER'S SLICE, and no one else's. */
  readonly platformMinor: bigint;
}

export interface EngineerDueRow {
  readonly currency: string;
  /** Positive: owed to the engineer. Negative: the engineer owes the platform. */
  readonly balanceMinor: bigint;
  /** Already paid out through settlements, all time. */
  readonly settledMinor: bigint;
}

/** Sales per engineer per currency, from the engineer's own frozen rows. */
async function salesByEngineer(
  tx: Transaction,
  contributorIds: readonly string[],
): Promise<Map<string, EngineerSalesRow[]>> {
  const byEngineer = new Map<string, EngineerSalesRow[]>();
  if (contributorIds.length === 0) return byEngineer;

  /*
   * ONE TABLE — `order_item_contributors` — and every figure comes from the
   * engineer's OWN row on it. `slice_minor` and `platform_amount_minor` are
   * per-engineer since migration 0050; the older per-LINE columns on
   * `order_items` would be counted once per credited engineer here, which on a
   * two-author product reports the platform's cut twice.
   *
   * Rows written before 0050 have no slice. They are counted in `units_sold`
   * and their money is counted, because the money is right — it is only the
   * "what was my rate applied to" column that did not exist yet.
   */
  const rows = (await tx.execute(sql`
    SELECT oic.contributor_id,
           oic.currency,
           COUNT(*)::int                                     AS units_sold,
           COALESCE(SUM(oic.slice_minor), 0)::text           AS slice,
           COALESCE(SUM(oic.amount_minor), 0)::text          AS engineer,
           COALESCE(SUM(oic.platform_amount_minor), 0)::text AS platform
      FROM order_item_contributors oic
     -- An interpolated array expands to IN ($1, $2, $3) here, which is valid
     -- SQL. The trap CLAUDE.md records is the same interpolation inside
     -- = ANY(...), where it becomes a ROW CONSTRUCTOR and PostgreSQL refuses
     -- it. The empty case returns above, because IN () is a syntax error.
     WHERE oic.contributor_id IN ${contributorIds}
       AND oic.currency IS NOT NULL
     GROUP BY oic.contributor_id, oic.currency
     ORDER BY 1, 2
  `)) as unknown as Array<Record<string, string | number>>;

  for (const row of rows) {
    const key = row.contributor_id as string;
    const list = byEngineer.get(key) ?? [];
    list.push({
      currency: row.currency as string,
      unitsSold: Number(row.units_sold),
      sliceMinor: BigInt(row.slice as string),
      engineerMinor: BigInt(row.engineer as string),
      platformMinor: BigInt(row.platform as string),
    });
    byEngineer.set(key, list);
  }
  return byEngineer;
}

/** What is still owed, and what has already been settled. */
async function duesByEngineer(
  tx: Transaction,
  contributorIds: readonly string[],
): Promise<Map<string, EngineerDueRow[]>> {
  const byEngineer = new Map<string, EngineerDueRow[]>();
  if (contributorIds.length === 0) return byEngineer;

  /*
   * THE LEDGER, AND NOTHING ELSE (P6). A payable is a credit, so the balance
   * is `SUM(-amount_minor)` on the engineer's payable account — the same
   * expression `outstandingPayables` uses, deliberately, because two different
   * ways of computing one balance is one way too many.
   *
   * `settled` is what has actually left: the SETTLEMENT_PAYOUT entries, which
   * DEBIT the payable account and so carry a positive amount.
   */
  const rows = (await tx.execute(sql`
    SELECT l.contributor_id,
           l.currency,
           SUM(-l.amount_minor)::text                                       AS balance,
           COALESCE(SUM(l.amount_minor) FILTER (
             WHERE l.kind = 'SETTLEMENT_PAYOUT'), 0)::text                  AS settled
      FROM ledger_lines l
     WHERE l.account_code = ${LEDGER_ACCOUNTS.ENGINEER_PAYABLE}
       AND l.contributor_id IN ${contributorIds}
     GROUP BY l.contributor_id, l.currency
     ORDER BY 1, 2
  `)) as unknown as Array<Record<string, string>>;

  for (const row of rows) {
    const key = row.contributor_id!;
    const list = byEngineer.get(key) ?? [];
    list.push({
      currency: row.currency!,
      balanceMinor: BigInt(row.balance!),
      settledMinor: BigInt(row.settled!),
    });
    byEngineer.set(key, list);
  }
  return byEngineer;
}

/**
 * Every engineer on the platform, with everything the owner's list shows.
 *
 * Active first, then by name: the owner works from the list of people who are
 * currently publishing, and a deactivated account should not sit between two
 * of them.
 */
export async function engineerRoster(actor: Actor): Promise<readonly EngineerRosterRow[]> {
  requireOwner(actor, 'شاشة المهندسين');

  return withActor(actor, async (tx) => {
    const base = await tx
      .select({
        contributorId: contributors.id,
        userId: contributors.userId,
        email: users.email,
        displayName: contributors.displayName,
        publicSlug: contributors.publicSlug,
        settlementCode: contributors.settlementCode,
        disciplineId: contributors.disciplineId,
        disciplineNameAr: disciplines.nameAr,
        specialization: contributors.specialization,
        isActive: contributors.isActive,
        canSubmitDrafts: contributors.canSubmitDrafts,
        model: commissionAgreements.model,
        engineerBp: commissionAgreements.engineerBp,
      })
      .from(contributors)
      .innerJoin(users, eq(users.id, contributors.userId))
      .leftJoin(disciplines, eq(disciplines.id, contributors.disciplineId))
      .leftJoin(
        commissionAgreements,
        and(
          eq(commissionAgreements.contributorId, contributors.id),
          isNull(commissionAgreements.productId),
          isNull(commissionAgreements.effectiveTo),
        ),
      )
      .orderBy(desc(contributors.isActive), asc(contributors.displayName))
      .limit(500);

    const ids = base.map((row) => row.contributorId);
    if (ids.length === 0) return [];

    /*
     * `inArray`, never `= ANY(${array})` in a template: interpolating a
     * JavaScript array expands it to one placeholder PER ELEMENT, producing a
     * row constructor PostgreSQL refuses — and it passes tsc and lint, then
     * throws on the first page load with more than one engineer.
     */
    const counts = await tx
      .select({
        contributorId: productContributors.contributorId,
        total: sql<number>`COUNT(*)::int`,
        published: sql<number>`COUNT(*) FILTER (WHERE ${products.status} = 'PUBLISHED')::int`,
      })
      .from(productContributors)
      .innerJoin(products, eq(products.id, productContributors.productId))
      .where(inArray(productContributors.contributorId, ids))
      .groupBy(productContributors.contributorId);

    const countBy = new Map(counts.map((row) => [row.contributorId, row]));
    const salesBy = await salesByEngineer(tx, ids);
    const duesBy = await duesByEngineer(tx, ids);

    return base.map((row) => ({
      ...row,
      productsTotal: Number(countBy.get(row.contributorId)?.total ?? 0),
      productsPublished: Number(countBy.get(row.contributorId)?.published ?? 0),
      sales: salesBy.get(row.contributorId) ?? [],
      dues: duesBy.get(row.contributorId) ?? [],
    }));
  });
}

export interface EngineerProductRow {
  readonly productId: string;
  readonly slug: string;
  readonly titleAr: string;
  readonly status: string;
  readonly fileType: string;
  readonly shareBp: number;
  /** The price in force, or null while the product has none yet. */
  readonly priceMinor: bigint | null;
  readonly currency: string | null;
  /**
   * The terms that would apply TO THIS ENGINEER on this product: the override
   * if there is one, otherwise their default. Owner-only — §12 keeps a rate
   * away from everyone else, this engineer's colleagues most of all.
   */
  readonly model: CommissionModel | null;
  readonly engineerBp: number | null;
  readonly engineerFixedMinor: bigint | null;
  readonly platformFixedMinor: bigint | null;
  /** True when the rate above is set for this product specifically. */
  readonly isOverride: boolean;
}

export interface EngineerDetail {
  readonly engineer: EngineerRosterRow;
  readonly products: readonly EngineerProductRow[];
}

/** One engineer, their catalogue, and the rate each product pays them. */
export async function engineerDetail(
  actor: Actor,
  contributorId: string,
): Promise<EngineerDetail | null> {
  requireOwner(actor, 'ملف المهندس');

  const roster = await engineerRoster(actor);
  const engineer = roster.find((row) => row.contributorId === contributorId);
  if (!engineer) return null;

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT p.id, p.slug, p.title_ar, p.status::text AS status,
             p.file_type::text AS file_type, pc.share_bp,
             pr.amount_minor::text AS price_minor, pr.currency,
             /*
              * The narrower agreement wins, exactly as the sale path resolves
              * it: an override for this product, else the engineer's default.
              * DISTINCT ON with that ordering picks the override when one
              * exists and the default otherwise, in one pass.
              */
             ca.model::text AS model, ca.engineer_bp,
             ca.engineer_fixed_minor::text AS engineer_fixed_minor,
             ca.platform_fixed_minor::text AS platform_fixed_minor,
             (ca.product_id IS NOT NULL) AS is_override
        FROM product_contributors pc
        JOIN products p ON p.id = pc.product_id
        LEFT JOIN LATERAL (
          SELECT amount_minor, currency FROM product_prices
           WHERE product_id = p.id AND effective_to IS NULL
           ORDER BY effective_from DESC, id DESC LIMIT 1
        ) pr ON true
        LEFT JOIN LATERAL (
          SELECT model, engineer_bp, engineer_fixed_minor, platform_fixed_minor, product_id
            FROM commission_agreements
           WHERE contributor_id = pc.contributor_id
             AND effective_to IS NULL
             AND (product_id = p.id OR product_id IS NULL)
           ORDER BY (product_id IS NULL), effective_from DESC, id DESC
           LIMIT 1
        ) ca ON true
       WHERE pc.contributor_id = ${contributorId}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT 300
    `)) as unknown as Array<Record<string, string | number | boolean | null>>;

    return {
      engineer,
      products: rows.map((row) => ({
        productId: row.id as string,
        slug: row.slug as string,
        titleAr: row.title_ar as string,
        status: row.status as string,
        fileType: row.file_type as string,
        shareBp: Number(row.share_bp),
        priceMinor: row.price_minor == null ? null : BigInt(row.price_minor as string),
        currency: (row.currency as string | null) ?? null,
        model: (row.model as CommissionModel | null) ?? null,
        engineerBp: row.engineer_bp == null ? null : Number(row.engineer_bp),
        engineerFixedMinor: row.engineer_fixed_minor == null
          ? null : BigInt(row.engineer_fixed_minor as string),
        platformFixedMinor: row.platform_fixed_minor == null
          ? null : BigInt(row.platform_fixed_minor as string),
        isOverride: row.is_override === true,
      })),
    };
  });
}

/** The four disciplines, for the form's select. */
export async function disciplineOptions(
  actor: Actor,
): Promise<readonly { id: string; nameAr: string }[]> {
  requireOwner(actor, 'شاشة المهندسين');
  return withActor(actor, (tx) =>
    tx.select({ id: disciplines.id, nameAr: disciplines.nameAr })
      .from(disciplines)
      .orderBy(asc(disciplines.sortOrder))
      .limit(50),
  );
}

// ---------------------------------------------------------------------------
// WRITES
// ---------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,23}$/;

export interface AddEngineerInput {
  /** An account that ALREADY EXISTS. See the refusal below for why. */
  readonly email: string;
  readonly displayName: string;
  readonly publicSlug: string;
  readonly settlementCode: string;
  readonly disciplineId?: string | null;
  readonly specialization?: string | null;
  readonly bio?: string | null;
}

/**
 * Give an existing account an engineer profile.
 *
 * WHY THIS TAKES AN EMAIL AND NOT A PASSWORD. The platform has self
 * registration with email confirmation (OPEN-23), and specification §32/§46
 * says plainly that registering grants no publication rights — the owner
 * authorises the contributor afterwards. So the engineer creates their own
 * account and chooses their own password, and this call turns that account
 * into an engineer.
 *
 * An owner-typed password would mean the owner knows the engineer's
 * credentials, which makes every audit entry attributable to two people, and
 * would be a second account-creation path beside the registration one. If no
 * account exists yet this REFUSES and says so — the rule against guessing
 * applies to identity as much as to money.
 *
 * THE PROFILE IS CREATED INACTIVE. Activation is a separate, audited decision
 * (§46), and a profile that went live the moment it was typed would make the
 * activate/deactivate control decorative.
 */
export async function addEngineer(
  actor: Actor,
  input: AddEngineerInput,
): Promise<{ contributorId: string }> {
  requireOwner(actor, 'إضافة مهندس');

  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  const publicSlug = input.publicSlug.trim().toLowerCase();
  const settlementCode = input.settlementCode.trim().toUpperCase();

  if (!email.includes('@')) throw new ValidationError('البريد الإلكتروني غير صالح');
  if (displayName.length < 2) throw new ValidationError('اسم المهندس مطلوب');
  if (!SLUG_PATTERN.test(publicSlug)) {
    throw new ValidationError(
      'العنوان اللطيف يقبل الحروف اللاتينية الصغيرة والأرقام والشرطة فقط، مثل ahmad-civil',
    );
  }
  if (!CODE_PATTERN.test(settlementCode)) {
    throw new ValidationError('رمز التسوية يقبل الحروف اللاتينية الكبيرة والأرقام والشرطة، مثل CIVIL-01');
  }

  return withActor(actor, async (tx) => {
    const [user] = await tx
      .select({ id: users.id, role: users.role, status: users.status })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      throw new ValidationError(
        'لا يوجد حساب بهذا البريد. اطلب من المهندس التسجيل وتأكيد بريده أولاً، ثم أضفه هنا.',
      );
    }
    if (user.role === 'OWNER') {
      // The single-owner index (migration 0041) makes the platform owner one
      // person; giving them a contributor profile would put the owner on both
      // sides of every commission agreement.
      throw new RuleViolationError('حساب المالك لا يصلح ملفاً لمهندس');
    }

    const [existing] = await tx
      .select({ id: contributors.id })
      .from(contributors)
      .where(eq(contributors.userId, user.id))
      .limit(1);
    if (existing) {
      throw new ValidationError('هذا الحساب مسجَّل بالفعل كمهندس');
    }

    if (input.disciplineId) {
      const [discipline] = await tx
        .select({ id: disciplines.id })
        .from(disciplines)
        .where(eq(disciplines.id, input.disciplineId))
        .limit(1);
      if (!discipline) throw new ValidationError('التخصص المختار غير موجود');
    }

    const [created] = await tx
      .insert(contributors)
      .values({
        userId: user.id,
        publicSlug,
        settlementCode,
        displayName,
        disciplineId: input.disciplineId ?? null,
        specialization: input.specialization?.trim() || null,
        bio: input.bio?.trim() || null,
        // Inactive on purpose — see the note above.
        isActive: false,
        canSubmitDrafts: false,
      })
      .returning({ id: contributors.id });

    // RLS refuses a write by returning no rows rather than raising.
    if (!created) throw new RuleViolationError('تعذّر إنشاء ملف المهندس');

    /*
     * The account's role follows the profile. A CONTRIBUTOR row whose user is
     * still a CUSTOMER would fail `console.contributor.access` at the route
     * gate, and the engineer would be told their own console does not exist.
     */
    if (user.role !== 'CONTRIBUTOR') {
      const [changed] = await tx
        .update(users)
        .set({ role: 'CONTRIBUTOR' })
        .where(eq(users.id, user.id))
        .returning({ id: users.id });
      if (!changed) throw new RuleViolationError('تعذّر تحديث دور الحساب');

      await recordAudit(tx, actor, {
        action: 'USER_ROLE_CHANGED',
        entityType: 'user',
        entityId: user.id,
        before: { role: user.role },
        after: { role: 'CONTRIBUTOR' },
      });
    }

    await recordAudit(tx, actor, {
      action: 'CONTRIBUTOR_CREATED',
      entityType: 'contributor',
      entityId: created.id,
      after: { userId: user.id, displayName, publicSlug, settlementCode, isActive: false },
    });

    return { contributorId: created.id };
  });
}

export interface UpdateEngineerInput {
  readonly contributorId: string;
  readonly displayName: string;
  readonly disciplineId?: string | null;
  readonly specialization?: string | null;
  readonly bio?: string | null;
}

/**
 * Edit an engineer's profile.
 *
 * The slug and the settlement code are NOT editable here. The slug is the
 * engineer's permanent public address and the code appears on issued
 * statements — "SEP-2026-CIVIL" means nothing if CIVIL can be renamed
 * afterwards. Changing either is a decision with consequences outside this
 * screen, so it does not happen by typing in a text field.
 */
export async function updateEngineer(
  actor: Actor,
  input: UpdateEngineerInput,
): Promise<void> {
  requireOwner(actor, 'تعديل بيانات المهندس');

  const displayName = input.displayName.trim();
  if (displayName.length < 2) throw new ValidationError('اسم المهندس مطلوب');

  await withActor(actor, async (tx) => {
    const [before] = await tx
      .select({
        displayName: contributors.displayName,
        disciplineId: contributors.disciplineId,
        specialization: contributors.specialization,
        bio: contributors.bio,
      })
      .from(contributors)
      .where(eq(contributors.id, input.contributorId))
      .limit(1);
    if (!before) throw new NotFoundError('المهندس غير موجود');

    if (input.disciplineId) {
      const [discipline] = await tx
        .select({ id: disciplines.id })
        .from(disciplines)
        .where(eq(disciplines.id, input.disciplineId))
        .limit(1);
      if (!discipline) throw new ValidationError('التخصص المختار غير موجود');
    }

    const after = {
      displayName,
      disciplineId: input.disciplineId ?? null,
      specialization: input.specialization?.trim() || null,
      bio: input.bio?.trim() || null,
    };

    const [changed] = await tx
      .update(contributors)
      .set({ ...after, updatedAt: new Date() })
      .where(eq(contributors.id, input.contributorId))
      .returning({ id: contributors.id });
    if (!changed) throw new RuleViolationError('تعذّر تعديل بيانات المهندس');

    await recordAudit(tx, actor, {
      action: 'CONTRIBUTOR_UPDATED',
      entityType: 'contributor',
      entityId: input.contributorId,
      before,
      after,
    });
  });
}

/**
 * Activate or deactivate an engineer.
 *
 * Deactivating hides the public profile and stops the account acting as a
 * contributor. It does NOT touch a single past sale, entitlement, ledger line
 * or settlement: money already earned stays owed, and the monthly statement
 * keeps being generated for it. An engineer who leaves is still paid what the
 * platform owes them — anything else would make deactivation a way to erase a
 * debt, which is the one thing this control must never be.
 */
export async function setEngineerActive(
  actor: Actor,
  input: { contributorId: string; isActive: boolean },
): Promise<void> {
  requireOwner(actor, 'تفعيل المهندس');

  await withActor(actor, async (tx) => {
    const [before] = await tx
      .select({ isActive: contributors.isActive })
      .from(contributors)
      .where(eq(contributors.id, input.contributorId))
      .limit(1);
    if (!before) throw new NotFoundError('المهندس غير موجود');

    const [changed] = await tx
      .update(contributors)
      .set({
        isActive: input.isActive,
        approvedBy: input.isActive && actor.kind === 'USER' ? actor.userId : undefined,
        approvedAt: input.isActive ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .where(eq(contributors.id, input.contributorId))
      .returning({ id: contributors.id });
    if (!changed) throw new RuleViolationError('تعذّر تغيير حالة المهندس');

    await recordAudit(tx, actor, {
      action: input.isActive ? 'CONTRIBUTOR_ACTIVATED' : 'CONTRIBUTOR_DEACTIVATED',
      entityType: 'contributor',
      entityId: input.contributorId,
      before,
      after: { isActive: input.isActive },
    });
  });
}
