/**
 * ===========================================================================
 * DISPLAY LABELS — shared by server components and client components
 * ===========================================================================
 * These live in a PLAIN module, not beside the forms that use them, and the
 * reason is a bug that shipped:
 *
 *   A module marked `'use client'` is a client boundary. When a SERVER
 *   component imports a value from it, it receives a client reference, not the
 *   object — so `LABELS[key]` is `undefined` and the page silently renders the
 *   raw enum value. No error, no type complaint, no failing test: the screen
 *   just says BANK_FEE_OR_SHORTFALL to the owner instead of Arabic.
 *
 * It was found by photographing the real page. `src/lib/labels.test.ts` now
 * asserts that no page imports a label map from a client component.
 * ===========================================================================
 */

export const SETTLEMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'بانتظار الاعتماد',
  APPROVED: 'معتمد — بانتظار التحويل',
  PAID: 'مصروف',
  CARRIED_FORWARD: 'مُرحَّل إلى الشهر التالي',
  CANCELLED: 'ملغى',
};

export const ADJUSTMENT_REASON_LABELS: Readonly<Record<string, string>> = {
  DATA_ENTRY_ERROR: 'خطأ إدخال',
  DUPLICATE_PAYMENT_RECEIVED: 'دفعة مستلمة مكررة',
  BANK_FEE_OR_SHORTFALL: 'رسوم أو نقص تحويل',
  AGREED_COMPENSATION: 'تعويض متفق عليه',
  SETTLEMENT_CORRECTION: 'تصحيح تسوية',
  OTHER: 'سبب آخر',
};

export const ADJUSTMENT_TARGET_LABELS: Readonly<Record<string, string>> = {
  ENGINEER: 'رصيد مهندس',
  PLATFORM: 'حساب المنصة',
};

export const ADJUSTMENT_DIRECTION_LABELS: Readonly<Record<string, string>> = {
  INCREASE: 'زيادة',
  DECREASE: 'خصم',
};

export const ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  DRAFT: 'مسودة',
  AWAITING_PAYMENT: 'بانتظار الدفع',
  PROOF_SUBMITTED: 'قيد التحقق',
  PENDING_VERIFICATION: 'قيد التحقق',
  PAID: 'مدفوع',
  COMPLETED: 'مكتمل',
  PAYMENT_ISSUE: 'مشكلة في الدفع',
  CANCELLED: 'ملغى',
  REFUNDED: 'مُسترجع',
};

export const PRODUCT_STATUS_LABELS: Readonly<Record<string, string>> = {
  DRAFT: 'مسودّة',
  SUBMITTED: 'مُرسَل للمراجعة',
  IN_REVIEW: 'قيد المراجعة',
  REVISION_REQUESTED: 'مطلوب تعديل',
  APPROVED: 'معتمد — جاهز للنشر',
  PUBLISHED: 'منشور',
  UNPUBLISHED: 'غير منشور',
  ARCHIVED: 'مؤرشف',
};
