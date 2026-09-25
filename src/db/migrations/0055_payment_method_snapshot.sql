-- ===========================================================================
-- A PAYMENT KEEPS THE INSTRUCTIONS IT WAS GIVEN (Stage 2 audit, F3)
--
-- The order screen read the method's name, instructions and account details
-- from `payment_methods` at the moment it was rendered. Two things followed:
--
--   * the owner disables the method while a customer is still to transfer:
--     RLS hides an inactive method from customers, so the order lost its
--     instructions, its account details and its receipt upload — with the
--     money perhaps already sent;
--   * the owner changes the account details: every order waiting for a
--     transfer silently showed the NEW account, though the customer may
--     already have paid into the old one.
--
-- So the four things the customer needs to finish paying are copied onto the
-- payment when it is created, exactly as `order_items.title_snapshot` keeps
-- what was bought. Nothing else is copied: amount and currency are already
-- on the row, and the method id stays the reference for everything else.
--
-- RLS IS UNCHANGED. Customers still cannot see an inactive method; they see
-- their own payment, which now carries what they were told.
-- ===========================================================================

ALTER TABLE "payments"
  ADD COLUMN "method_name_snapshot" text,
  ADD COLUMN "instructions_snapshot" text,
  ADD COLUMN "account_details_snapshot" text,
  ADD COLUMN "requires_proof_snapshot" boolean;--> statement-breakpoint

-- `payments` and `payment_methods` carry FORCE ROW LEVEL SECURITY, so the
-- policies bind the table owner too; owner context is declared as 0040 does.
SELECT set_config('app.actor_role', 'OWNER', true);--> statement-breakpoint

-- scripts/seed-payment-methods.ts used to write this sentence where a bank
-- account belongs, and the checkout showed it to buyers as the account to pay
-- into. It is no account; it goes before anything is copied from it, and a
-- manual method without account details is no longer offered at all.
UPDATE "payment_methods"
   SET "account_details_ar" = NULL, "updated_at" = now()
 WHERE "account_details_ar" = 'يُعبّئها المالك من لوحة الإدارة';--> statement-breakpoint

-- Existing payments take what their method says today: the best record there
-- is of what their customer was shown.
UPDATE "payments" AS p
   SET "method_name_snapshot"     = m."display_name_ar",
       "instructions_snapshot"    = m."instructions_ar",
       "account_details_snapshot" = m."account_details_ar",
       "requires_proof_snapshot"  = m."requires_proof"
  FROM "payment_methods" AS m
 WHERE m."id" = p."payment_method_id";--> statement-breakpoint

SELECT set_config('app.actor_role', '', true);--> statement-breakpoint

-- Every payment has a method (NOT NULL, ON DELETE RESTRICT), so every row was
-- filled; from here on the insert must supply them.
ALTER TABLE "payments"
  ALTER COLUMN "method_name_snapshot" SET NOT NULL,
  ALTER COLUMN "requires_proof_snapshot" SET NOT NULL;
