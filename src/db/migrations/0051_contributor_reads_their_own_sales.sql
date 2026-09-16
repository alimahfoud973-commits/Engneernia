-- ===========================================================================
-- THE ENGINEER'S OWN SALES, READABLE BY THE ENGINEER
-- ===========================================================================
-- `/account/earnings` calls `contributorSales(actor)` as the engineer, and the
-- query behind it reads:
--
--     FROM order_item_contributors oic
--     JOIN order_items oi ON oi.id = oic.order_item_id
--     JOIN orders      o  ON o.id  = oi.order_id
--
-- Migration 0043 took `order_items` away from contributors — correctly, since
-- that row carries the figures a co-author could read backwards into a
-- colleague's pay. But an INNER JOIN through an invisible table returns
-- nothing, so since 0043 the engineer's "sales behind your balance" table has
-- been EMPTY. No error, no failing test, no log line: the screen renders, and
-- says the engineer has never sold anything.
--
-- Measured before it was fixed, in `per-contributor-commission.itest.ts`.
--
-- SECURITY DEFINER WOULD NOT HELP HERE. `orders`, `order_items` and
-- `order_item_contributors` are all FORCE ROW LEVEL SECURITY, which applies to
-- the table owner too — so a trusted function reading them sees exactly what
-- its caller would. (CLAUDE.md records this trap; it has caught us before.)
--
-- So the engineer's own row carries its own context, the way every other
-- append-only trail in this schema does (`order_events`, `ledger_lines`): a
-- date and a currency, denormalised at the moment of sale. The engineer then
-- reads ONE table — the one whose rows are already theirs by policy — and no
-- join can widen or empty the result.
--
-- NOTHING NEW IS DISCLOSED. The date and currency of their own sale already
-- reach them on their monthly statement. What this removes is a join, not a
-- boundary.
-- ===========================================================================

ALTER TABLE "order_item_contributors"
  ADD COLUMN IF NOT EXISTS "occurred_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "currency"    text;
--> statement-breakpoint

-- Backfill from the sales that already exist. Reading `orders` and
-- `order_items` here is the MIGRATION's read, not the application's: this runs
-- as `migrator`, which owns both tables and is not subject to their policies
-- during DDL. Existing rows therefore arrive complete rather than blank.
UPDATE "order_item_contributors" oic
   SET "occurred_at" = o.paid_at,
       "currency"    = oi.currency
  FROM "order_items" oi
  JOIN "orders" o ON o.id = oi.order_id
 WHERE oi.id = oic.order_item_id
   AND oic.occurred_at IS NULL;
--> statement-breakpoint

ALTER TABLE "order_item_contributors"
  ADD CONSTRAINT "order_item_contributors_currency_format"
  CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "order_item_contributors_period_idx"
  ON "order_item_contributors" ("contributor_id", "occurred_at");
--> statement-breakpoint
