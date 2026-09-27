-- ===========================================================================
-- "NO REFERENCE" IS NULL, NOT '' (Stage 3 admin audit, W13)
--
-- Approving a payment with the optional bank reference left empty stored ''
-- — the browser sends an empty text field, and nothing turned it into "none".
-- To the unique index `payments_provider_ref_unique (payment_method_id,
-- provider_ref)` '' is a value: after the first such approval, every later
-- approval without a reference on the same method collided with it.
--
-- `approvePayment` now trims the reference and writes NULL when nothing is
-- left (src/commerce/provider-ref.ts). This brings rows written before that
-- in line: an empty or whitespace-only reference becomes NULL.
--
-- Only those. A real reference is left exactly as stored — no trimming, no
-- change of letter case. NULL never conflicts under the index (NULLS
-- DISTINCT), so this cannot fail on a duplicate. `updated_at` is left alone:
-- the reference was absent all along; only its spelling changes.
-- ===========================================================================

-- `payments` carries FORCE ROW LEVEL SECURITY, so the policies bind the table
-- owner too; owner context is declared as 0055 does.
SELECT set_config('app.actor_role', 'OWNER', true);--> statement-breakpoint

UPDATE "payments"
   SET "provider_ref" = NULL
 WHERE "provider_ref" ~ '^[[:space:]]*$';--> statement-breakpoint

SELECT set_config('app.actor_role', '', true);
