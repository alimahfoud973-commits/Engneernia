-- The affected engineer is told their balance moved, and why.
--
-- A separate migration because 0036 is applied; appending to an applied file
-- leaves its recorded hash disagreeing with its contents.
--
-- One recipient, as §33 requires: the engineer the adjustment names. The
-- payload carries the public reason the owner typed — the same text that goes
-- on the ledger line — and never the internal record, which is owner-only.
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'BALANCE_ADJUSTED';
