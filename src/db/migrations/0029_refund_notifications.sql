-- ===========================================================================
-- NOTIFICATIONS FOR THE REFUND FLOW (specification §33)
--
-- A separate migration because 0028 was already applied. Appending to an
-- applied file leaves its recorded hash disagreeing with its contents, and
-- every database that already ran it silently out of step.
--
-- Each of these has exactly ONE recipient. SALE_REVERSED goes to the
-- contributor whose sale was undone and never to the buyer, whose own refund
-- is reported to them by REFUND_APPROVED.
-- ===========================================================================

ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'REFUND_REQUESTED';--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'REFUND_APPROVED';--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'REFUND_REJECTED';--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'REFUND_PAID';--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'SALE_REVERSED';
