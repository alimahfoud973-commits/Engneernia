-- ============================================================================
-- A CONTRIBUTOR DOES NOT READ THE ORDER ITEM (owner decision §6, TD-29)
-- ============================================================================
-- `order_items_select` admitted any contributor credited on the product, and
-- the row it admitted them to carries `platform_amount_minor`, `net_minor` and
-- `unit_price_minor`. On a CO-AUTHORED product that is enough to compute a
-- colleague's exact earnings:
--
--     engineer pot      = net_minor - platform_amount_minor
--     colleagues' total = engineer pot - my own share
--
-- and on a two-author product "colleagues' total" is one person's pay. The
-- owner's decision in §6 is that an engineer never learns another engineer's
-- share; TD-29 records the same rule for the interface. Row-level security is
-- where it has to hold, because CLAUDE.md's fourth rule is that hiding a field
-- in the interface is not protection.
--
-- Nothing loses access that was using it. `order_items` is read by the sale
-- path (owner) and by `checkoutView` (the buyer's own order, covered by the
-- customer branch); no contributor-facing query reads this table at all. The
-- share an engineer is entitled to see already has its own correctly scoped
-- row in `order_item_contributors` — one line, theirs, and no one else's —
-- which is what a future "my sales" screen should be built on.
-- ============================================================================

DROP POLICY IF EXISTS "order_items_select" ON "order_items";
--> statement-breakpoint

CREATE POLICY "order_items_select" ON "order_items" FOR SELECT
  USING (
    app_is_owner()
    OR EXISTS (SELECT 1 FROM orders o
                WHERE o.id = order_items.order_id AND o.customer_id = app_actor_id())
  );
