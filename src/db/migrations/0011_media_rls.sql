-- ===========================================================================
-- FILE VISIBILITY (specification §27, §41 — decisions §11)
--
-- The single most important policy in the system. An ORIGINAL row must never
-- resolve for the public, under any query, from any page, in any state.
-- ===========================================================================

ALTER TABLE "product_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_files" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- PREVIEW and THUMBNAIL of a PUBLISHED product are public.
-- ORIGINAL is visible only to the owner and to credited contributors.
--
-- Entitled customers are added in phase P5, when purchasing exists; until
-- then there is deliberately no path at all from a customer to an original,
-- rather than a permissive placeholder policy waiting to be tightened.
CREATE POLICY "product_files_select" ON "product_files" FOR SELECT
  USING (
    app_is_owner()
    OR EXISTS (
      SELECT 1 FROM product_contributors pc
       WHERE pc.product_id = product_files.product_id
         AND pc.contributor_id = app_contributor_id()
    )
    OR (
      product_files.role IN ('PREVIEW', 'THUMBNAIL')
      AND EXISTS (
        SELECT 1 FROM products p
         WHERE p.id = product_files.product_id AND p.status = 'PUBLISHED'
      )
    )
  );
--> statement-breakpoint

-- Writes are the owner's. A contributor uploading their own draft goes
-- through the service layer, which runs as the owner only after checking the
-- contributor's draft rights — the same shape as product submission.
CREATE POLICY "product_files_write" ON "product_files" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- --- download_events ------------------------------------------------------
ALTER TABLE "download_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "download_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Only the owner reads the download trail; a user may see their own.
CREATE POLICY "download_events_select" ON "download_events" FOR SELECT
  USING (app_is_owner() OR "user_id" = app_actor_id());
--> statement-breakpoint

-- Any authenticated delivery appends its own record.
CREATE POLICY "download_events_insert" ON "download_events" FOR INSERT
  WITH CHECK (true);
--> statement-breakpoint

-- No UPDATE or DELETE policy: the download trail is append-only, for the same
-- reason the audit log is.
CREATE TRIGGER download_events_no_update
  BEFORE UPDATE ON "download_events"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();
--> statement-breakpoint

CREATE TRIGGER download_events_no_delete
  BEFORE DELETE ON "download_events"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();
--> statement-breakpoint

REVOKE UPDATE, DELETE ON "download_events" FROM app_user;--> statement-breakpoint

-- A file must never be recorded as clean without having been looked at.
ALTER TABLE "product_files"
  ADD CONSTRAINT "product_files_scan_timestamped"
  CHECK (scan_status = 'PENDING' OR scanned_at IS NOT NULL);
--> statement-breakpoint

ALTER TABLE "product_files"
  ADD CONSTRAINT "product_files_size_positive" CHECK (byte_size > 0);
--> statement-breakpoint

-- Page count belongs to PDFs and to nothing else (owner decision: preview is
-- PDF-only, so no other format carries a page concept here).
ALTER TABLE "product_files"
  ADD CONSTRAINT "product_files_pagecount_sane"
  CHECK (page_count IS NULL OR page_count > 0);
