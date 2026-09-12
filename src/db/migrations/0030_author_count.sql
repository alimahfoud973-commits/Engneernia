-- ===========================================================================
-- HOW MANY AUTHORS WERE CREDITED ON A SALE
--
-- Needed by the engineer's own dashboard, which shows the platform's share of
-- a sale only when that engineer wrote the product alone (decisions §6: a
-- contributor must not learn the other contributors' shares, and on a
-- co-authored sale "price − platform share − my share" IS that number).
--
-- It has to be a trusted path. Asked under the contributor's own privileges,
-- order_item_contributors returns only THEIR line — so every co-authored sale
-- would count one author and look sole-authored, which is precisely the case
-- the rule exists to catch. The function counts with the owner's reach and
-- returns a single integer: enough to answer "am I alone on this?", and not
-- enough to learn anything about who else is there.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_order_item_author_count(p_order_item_id uuid)
  RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT COUNT(*)::integer
      FROM order_item_contributors
     WHERE order_item_id = p_order_item_id;
  $$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app_order_item_author_count(uuid) TO app_user;
