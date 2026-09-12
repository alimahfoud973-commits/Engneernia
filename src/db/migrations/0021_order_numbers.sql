-- Human-facing order references.
--
-- A sequence rather than a count or a random string: the customer writes this
-- number on a bank transfer and the owner matches it by eye, so it has to be
-- short, unique, and impossible to collide under concurrency. It is NOT the
-- primary key — the id stays an opaque UUID so a reference on a receipt does
-- not reveal how many orders the platform has taken.
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1000;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_next_order_number() RETURNS text
  LANGUAGE sql VOLATILE SET search_path = public AS $$
    SELECT 'EN-' || to_char(now() AT TIME ZONE 'Asia/Damascus', 'YYYY') || '-' ||
           lpad(nextval('order_number_seq')::text, 6, '0');
  $$;
--> statement-breakpoint

GRANT USAGE ON SEQUENCE order_number_seq TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_next_order_number() TO app_user;
