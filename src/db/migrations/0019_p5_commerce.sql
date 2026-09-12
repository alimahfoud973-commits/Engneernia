-- NOTE: Drizzle's generated diff also proposed
--   ALTER TABLE "products" DROP COLUMN "search_vector";
-- It was REMOVED. That column is a GENERATED ALWAYS tsvector created by
-- migration 0015 and deliberately absent from the ORM schema so application
-- code can neither select nor write it. Drizzle reads the absence as a
-- deletion. Applying it would have dropped the column, its GIN index, and
-- every search on the site — silently, with the migration reporting success.
--
-- This is the hazard recorded in CLAUDE.md: after any hand-written migration,
-- the generated diff must be read before it is run.

CREATE TYPE "public"."commission_model" AS ENUM('PERCENTAGE', 'FIXED_ENGINEER', 'FIXED_PLATFORM');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('DRAFT', 'AWAITING_PAYMENT', 'PROOF_SUBMITTED', 'PENDING_VERIFICATION', 'PAID', 'COMPLETED', 'PAYMENT_ISSUE', 'CANCELLED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."payment_method_type" AS ENUM('MANUAL', 'GATEWAY', 'ASSISTED');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('INITIATED', 'AWAITING_PROOF', 'PROOF_SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."proof_decision" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "commission_agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contributor_id" uuid NOT NULL,
	"product_id" uuid,
	"model" "commission_model" NOT NULL,
	"engineer_bp" integer,
	"engineer_fixed_minor" bigint,
	"platform_fixed_minor" bigint,
	"currency" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"order_item_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"download_count" integer DEFAULT 0 NOT NULL,
	"last_downloaded_at" timestamp with time zone,
	"max_downloads" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"actor_user_id" uuid,
	"note" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_item_contributors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_item_id" uuid NOT NULL,
	"contributor_id" uuid NOT NULL,
	"share_bp" integer NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"title_snapshot" text NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"commission_model" "commission_model",
	"engineer_bp" integer,
	"engineer_amount_minor" bigint,
	"platform_amount_minor" bigint,
	"agreement_id" uuid,
	"price_row_id" uuid,
	"commission_clamped" boolean DEFAULT false NOT NULL,
	"snapshot_taken_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "order_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" text NOT NULL,
	"subtotal_minor" bigint DEFAULT 0 NOT NULL,
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"buyer_country" text,
	"placed_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"admin_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"type" "payment_method_type" NOT NULL,
	"display_name_ar" text NOT NULL,
	"display_name_en" text,
	"description_ar" text,
	"instructions_ar" text,
	"account_details_ar" text,
	"support_message_ar" text,
	"requires_proof" boolean DEFAULT true NOT NULL,
	"countries" text[] DEFAULT '{}' NOT NULL,
	"currencies" text[] DEFAULT '{}' NOT NULL,
	"min_amount_minor" bigint,
	"max_amount_minor" bigint,
	"is_active" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"provider_config_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"reference_note" text,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" "proof_decision" DEFAULT 'PENDING' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_method_id" uuid NOT NULL,
	"status" "payment_status" DEFAULT 'INITIATED' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"provider_ref" text,
	"fee_minor" bigint DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commission_agreements" ADD CONSTRAINT "commission_agreements_contributor_id_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_agreements" ADD CONSTRAINT "commission_agreements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_contributors" ADD CONSTRAINT "order_item_contributors_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_contributors" ADD CONSTRAINT "order_item_contributors_contributor_id_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_agreements_contributor_idx" ON "commission_agreements" USING btree ("contributor_id","effective_from");--> statement-breakpoint
CREATE INDEX "commission_agreements_product_idx" ON "commission_agreements" USING btree ("product_id","effective_from");--> statement-breakpoint
CREATE INDEX "entitlements_customer_idx" ON "entitlements" USING btree ("customer_id","granted_at");--> statement-breakpoint
CREATE INDEX "entitlements_product_idx" ON "entitlements" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_live_unique" ON "entitlements" USING btree ("customer_id","product_id","order_item_id");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_item_contributors_unique" ON "order_item_contributors" USING btree ("order_item_id","contributor_id");--> statement-breakpoint
CREATE INDEX "order_item_contributors_contributor_idx" ON "order_item_contributors" USING btree ("contributor_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_product_idx" ON "order_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_number_unique" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_code_unique" ON "payment_methods" USING btree ("code");--> statement-breakpoint
CREATE INDEX "payment_methods_active_idx" ON "payment_methods" USING btree ("is_active","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_proofs_storage_key_unique" ON "payment_proofs" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "payment_proofs_payment_idx" ON "payment_proofs" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_proofs_decision_idx" ON "payment_proofs" USING btree ("decision","submitted_at");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_ref_unique" ON "payments" USING btree ("payment_method_id","provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_unique" ON "payments" USING btree ("idempotency_key");--> statement-breakpoint
