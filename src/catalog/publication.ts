import { RuleViolationError } from '@/lib/errors';
import { isOwner, type Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * PUBLICATION WORKFLOW (specification §10)
 * ===========================================================================
 *
 *   DRAFT ──→ SUBMITTED ──→ IN_REVIEW ──→ APPROVED ──→ PUBLISHED ⇄ UNPUBLISHED
 *     ↑           ↑              │                                      │
 *     └───────────┴── REVISION_REQUESTED ←┘                          ARCHIVED
 *
 * Encoded as an explicit transition table rather than scattered `if` blocks,
 * because "which states can a contributor move a product between" is a
 * security question, not a UI question. An illegal transition throws; it is
 * never merely hidden from the interface.
 * ===========================================================================
 */

export type ProductStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'IN_REVIEW'
  | 'REVISION_REQUESTED'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'UNPUBLISHED'
  | 'ARCHIVED';

/** Who is permitted to make a given move. */
export type TransitionActor = 'OWNER' | 'CONTRIBUTOR';

interface Transition {
  readonly to: ProductStatus;
  readonly allowedFor: readonly TransitionActor[];
  readonly label: string;
}

/**
 * The complete, exhaustive transition table.
 *
 * A contributor appears in exactly two rows: submitting a draft, and
 * resubmitting after revisions were requested. Everything else — approval,
 * publication, unpublishing, archiving — is the owner's alone (§2.1, §10).
 */
const TRANSITIONS: Readonly<Record<ProductStatus, readonly Transition[]>> = Object.freeze({
  DRAFT: [
    { to: 'SUBMITTED', allowedFor: ['OWNER', 'CONTRIBUTOR'], label: 'إرسال للمراجعة' },
    { to: 'ARCHIVED', allowedFor: ['OWNER'], label: 'أرشفة' },
  ],
  SUBMITTED: [
    { to: 'IN_REVIEW', allowedFor: ['OWNER'], label: 'بدء المراجعة' },
    { to: 'DRAFT', allowedFor: ['OWNER'], label: 'إعادة إلى مسودة' },
  ],
  IN_REVIEW: [
    { to: 'APPROVED', allowedFor: ['OWNER'], label: 'اعتماد' },
    { to: 'REVISION_REQUESTED', allowedFor: ['OWNER'], label: 'طلب تعديلات' },
    { to: 'SUBMITTED', allowedFor: ['OWNER'], label: 'إرجاع لقائمة المراجعة' },
  ],
  REVISION_REQUESTED: [
    { to: 'SUBMITTED', allowedFor: ['OWNER', 'CONTRIBUTOR'], label: 'إعادة الإرسال' },
    { to: 'ARCHIVED', allowedFor: ['OWNER'], label: 'أرشفة' },
  ],
  APPROVED: [
    { to: 'PUBLISHED', allowedFor: ['OWNER'], label: 'نشر' },
    { to: 'REVISION_REQUESTED', allowedFor: ['OWNER'], label: 'طلب تعديلات' },
  ],
  PUBLISHED: [{ to: 'UNPUBLISHED', allowedFor: ['OWNER'], label: 'إلغاء النشر' }],
  UNPUBLISHED: [
    { to: 'PUBLISHED', allowedFor: ['OWNER'], label: 'إعادة النشر' },
    { to: 'ARCHIVED', allowedFor: ['OWNER'], label: 'أرشفة' },
  ],
  // Terminal. Specification §16/§37: history is kept, never destroyed.
  ARCHIVED: [],
});

/** The one state that is visible to the public. */
export const PUBLIC_STATUS: ProductStatus = 'PUBLISHED';

export function isPubliclyVisible(status: ProductStatus): boolean {
  return status === PUBLIC_STATUS;
}

export function transitionsFrom(status: ProductStatus, actor: TransitionActor): readonly Transition[] {
  return TRANSITIONS[status].filter((t) => t.allowedFor.includes(actor));
}

export function canTransition(
  from: ProductStatus,
  to: ProductStatus,
  actor: TransitionActor,
): boolean {
  return TRANSITIONS[from].some((t) => t.to === to && t.allowedFor.includes(actor));
}

/** Preconditions that must hold before a product may go live (§28). */
export interface PublishReadiness {
  readonly hasContributor: boolean;
  readonly hasCurrentPrice: boolean;
  readonly hasOriginalFile: boolean;
  readonly hasPreview: boolean;
  /** Decides whether a preview is required at all — owner decision: PDF only. */
  readonly requiresPreview: boolean;
  /** The original's scan state, and whether this deployment enforces scanning. */
  readonly fileIsServable: boolean;
  /**
   * Why a sale would be refused at payment approval — an engineer with no
   * agreement in force, or one in another currency (F2). Empty for a free
   * product. Computed by `productSaleBlockers`, the same check that guards
   * price, credit and agreement changes on a product already published.
   */
  readonly commissionBlockers: readonly string[];
}

/**
 * A product must not reach the public half-built.
 *
 * No credited engineer means a sale nobody can be paid for. No current price
 * means a checkout with nothing to charge. An unscanned original means
 * handing a customer a file the platform never looked at.
 *
 * A paid product whose engineer has no agreement in force (or one in another
 * currency) would reach the customer, take their transfer, and then be
 * refused when the owner approves the payment — so it is refused here instead.
 *
 * A missing preview blocks publication only for PDFs: by the owner's
 * decision, Excel, DWG, Revit and archives have no preview, so requiring one
 * would make those products unpublishable.
 *
 * Returns every reason rather than the first, so the admin screen can show a
 * checklist instead of one error at a time.
 */
export function publishBlockers(readiness: PublishReadiness): readonly string[] {
  const blockers: string[] = [];
  if (!readiness.hasContributor) blockers.push('لا يوجد مهندس منسوب إليه المنتج');
  if (!readiness.hasCurrentPrice) blockers.push('لا يوجد سعر حالي محدد');
  if (!readiness.hasOriginalFile) blockers.push('لم يُرفع الملف الأصلي');
  if (readiness.requiresPreview && !readiness.hasPreview) {
    blockers.push('لم تُولَّد معاينة الصفحات الخمس');
  }
  if (readiness.hasOriginalFile && !readiness.fileIsServable) {
    blockers.push('الملف الأصلي لم يجتز فحص البرمجيات الخبيثة');
  }
  blockers.push(...readiness.commissionBlockers);
  return blockers;
}

export function assertTransition(
  from: ProductStatus,
  to: ProductStatus,
  actor: Actor,
  readiness?: PublishReadiness,
): void {
  const transitionActor: TransitionActor = isOwner(actor) ? 'OWNER' : 'CONTRIBUTOR';

  if (!canTransition(from, to, transitionActor)) {
    throw new RuleViolationError('انتقال غير مسموح في سير عمل النشر', {
      from,
      to,
      actor: transitionActor,
      allowed: transitionsFrom(from, transitionActor).map((t) => t.to),
    });
  }

  if (to === 'PUBLISHED' && readiness) {
    const blockers = publishBlockers(readiness);
    if (blockers.length > 0) {
      throw new RuleViolationError('المنتج غير جاهز للنشر', { blockers });
    }
  }
}
