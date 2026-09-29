-- ===========================================================================
-- STAGE 7 — THE WORDS THE PAYMENT FLOW WAS MISSING
--
-- Three audit actions and one notification the manual payment flow needs
-- (Stage 7 fix plan, owner decisions D6 and S7-07):
--
--   PAYMENT_PROOF_SUBMITTED  a buyer's receipt upload. It was recorded as
--                            PAYMENT_APPROVED ("reused enum member"), so a
--                            filter on approvals counted customer uploads.
--                            Rows written before this stay as they were — the
--                            audit log is append-only — and are still told
--                            apart by entity_type = 'payment_proof'.
--   ORDER_CANCELLED          the owner cancels an order (rule 12).
--   PAYMENT_CANCELLED        a payment attempt closed without a decision: the
--                            buyer chose another method, or its order was
--                            cancelled.
--   ORDER_CANCELLED          (notification) the buyer is told when the owner
--                            cancels their order (D6).
--
-- ON ITS OWN, AND NOT USED BELOW. Drizzle applies every pending migration in
-- ONE transaction, and PostgreSQL refuses to use an enum value in the same
-- transaction that added it. Nothing in 0066 names these values; the
-- application uses them only once the migration has committed.
-- ===========================================================================

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'PAYMENT_PROOF_SUBMITTED';--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'ORDER_CANCELLED';--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'PAYMENT_CANCELLED';--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'ORDER_CANCELLED';
