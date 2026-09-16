-- ===========================================================================
-- OPEN-15 — A COMMISSION RATE PER ENGINEER, NOT PER PRODUCT
-- ===========================================================================
-- Until now one agreement governed a whole sale: the PRIMARY author's, meaning
-- whichever co-author held the largest credit. Two things were wrong with it.
--
--   A CO-AUTHOR WAS PAID AT A RATE THEY NEVER AGREED TO. §11 defines an
--   agreement between the owner and ONE contributor. Applying the lead's 80%
--   to a colleague who signed at 60% is not a rounding detail — it is paying
--   somebody on somebody else's contract.
--
--   AND THE SALE COULD BE READ BACKWARDS. With one governing rate, the pot was
--   `(price - tax) x that rate`; subtract your own pay and the remainder was
--   your colleagues' pay, exact to the minor unit. That is KI-3, and no
--   row-level policy could close it, because every input was legitimately the
--   reader's own: the price is public, the rate was theirs, the pay is theirs.
--
-- THE NEW ORDER OF OPERATIONS:
--
--     price → less discount → less tax → NET
--     NET   → split by credit          → a slice per engineer
--     slice → that engineer's agreement → their pay + the platform's cut of it
--
-- WHY THE MONEY STILL RE-ADDS. The split into slices is largest-remainder, so
-- the slices sum to the net exactly; each slice is then divided into two parts
-- that sum to that slice exactly. A sum of exact sums is exact, so
-- `engineers + platform + tax = paid` is untouched — and it must be, because
-- `app_post_ledger_transaction` refuses an entry that does not sum to zero.
--
-- WHY THIS CLOSES KI-3. A colleague's pay is now a function of THEIR rate,
-- which §12 keeps private. From your own price, rate and pay you can still
-- recover your own slice, and therefore the others' combined SLICE — but a
-- slice is not a payment. No figure any colleague received is reachable.
-- Measured in `src/finance/per-contributor-commission.itest.ts`.
-- ===========================================================================


-- --- 1. this engineer's own terms, frozen onto the sale --------------------
-- The line already froze one set of commission columns. These are the same
-- idea one level down, where the terms actually live now.
ALTER TABLE "order_item_contributors"
  ADD COLUMN IF NOT EXISTS "slice_minor"           bigint,
  ADD COLUMN IF NOT EXISTS "platform_amount_minor" bigint,
  ADD COLUMN IF NOT EXISTS "agreement_id"          uuid,
  ADD COLUMN IF NOT EXISTS "commission_model"      commission_model,
  ADD COLUMN IF NOT EXISTS "engineer_bp"           integer,
  ADD COLUMN IF NOT EXISTS "engineer_fixed_minor"  bigint,
  ADD COLUMN IF NOT EXISTS "platform_fixed_minor"  bigint,
  ADD COLUMN IF NOT EXISTS "commission_clamped"    boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Each engineer's two parts must re-add to the slice their terms applied to.
-- The line-level constraint proves the slices sum to the net; this proves each
-- slice was divided without losing or inventing a minor unit. Together they
-- are the whole equation, in two halves that cannot be satisfied separately.
--
-- `slice_minor IS NULL` exempts every sale recorded before today: their totals
-- are correct on the line and in the ledger, and a constraint that demanded
-- these columns of them would fail this migration on any live database.
ALTER TABLE "order_item_contributors"
  ADD CONSTRAINT "order_item_contributors_split_balances"
  CHECK (
    slice_minor IS NULL
    OR (platform_amount_minor IS NOT NULL
        AND amount_minor >= 0
        AND platform_amount_minor >= 0
        AND amount_minor + platform_amount_minor = slice_minor)
  );
--> statement-breakpoint

-- A percentage agreement carries a rate; the fixed models do not. Stated here
-- so a row cannot describe terms that could not have produced it.
ALTER TABLE "order_item_contributors"
  ADD CONSTRAINT "order_item_contributors_model_shape"
  CHECK (
    commission_model IS NULL
    OR (commission_model = 'PERCENTAGE'
         AND engineer_bp IS NOT NULL AND engineer_bp BETWEEN 0 AND 10000)
    OR (commission_model = 'FIXED_ENGINEER'  AND engineer_fixed_minor  IS NOT NULL)
    OR (commission_model = 'FIXED_PLATFORM'  AND platform_fixed_minor  IS NOT NULL)
  );
--> statement-breakpoint

-- NOTE ON IMMUTABILITY. No trigger is added: `order_item_contributors_guard`
-- (migration 0020) already refuses EVERY update to this table, so the new
-- columns are frozen from the moment they are written, by a rule that predates
-- them. Verified rather than assumed — the test suite changes one and watches
-- the database refuse.
