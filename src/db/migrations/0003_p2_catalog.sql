CREATE TYPE "public"."file_type" AS ENUM('PDF', 'EXCEL', 'CAD', 'REVIT_BIM', 'TEMPLATE', 'PROJECT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."product_level" AS ENUM('BEGINNER', 'INTERMEDIATE', 'ADVANCED');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED', 'APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discipline_id" uuid NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disciplines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"description_ar" text,
	"icon_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_contributors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"contributor_id" uuid NOT NULL,
	"share_bp" integer NOT NULL,
	"credit_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"changed_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title_ar" text NOT NULL,
	"title_en" text,
	"subtitle_ar" text,
	"description_ar" text,
	"discipline_id" uuid NOT NULL,
	"category_id" uuid,
	"file_type" "file_type" DEFAULT 'PDF' NOT NULL,
	"language" text DEFAULT 'ar' NOT NULL,
	"level" "product_level",
	"software_tags" text[] DEFAULT '{}' NOT NULL,
	"status" "product_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"is_free" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"sales_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_discipline_id_disciplines_id_fk" FOREIGN KEY ("discipline_id") REFERENCES "public"."disciplines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_contributors" ADD CONSTRAINT "product_contributors_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_contributors" ADD CONSTRAINT "product_contributors_contributor_id_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_discipline_id_disciplines_id_fk" FOREIGN KEY ("discipline_id") REFERENCES "public"."disciplines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_discipline_slug_unique" ON "categories" USING btree ("discipline_id","slug");--> statement-breakpoint
CREATE INDEX "categories_discipline_order_idx" ON "categories" USING btree ("discipline_id","sort_order");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disciplines_slug_unique" ON "disciplines" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "disciplines_active_order_idx" ON "disciplines" USING btree ("is_active","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "product_contributors_unique" ON "product_contributors" USING btree ("product_id","contributor_id");--> statement-breakpoint
CREATE INDEX "product_contributors_contributor_idx" ON "product_contributors" USING btree ("contributor_id");--> statement-breakpoint
CREATE INDEX "product_prices_product_idx" ON "product_prices" USING btree ("product_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "product_prices_one_current" ON "product_prices" USING btree ("product_id") WHERE "product_prices"."effective_to" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_unique" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "products_discipline_status_idx" ON "products" USING btree ("discipline_id","status");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_status_published_idx" ON "products" USING btree ("status","published_at");