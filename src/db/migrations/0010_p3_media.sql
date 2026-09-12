CREATE TYPE "public"."file_role" AS ENUM('ORIGINAL', 'PREVIEW', 'THUMBNAIL');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('PENDING', 'CLEAN', 'INFECTED', 'SKIPPED', 'FAILED');--> statement-breakpoint
CREATE TABLE "download_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_file_id" uuid NOT NULL,
	"user_id" uuid,
	"grant_reason" text NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"byte_size" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"role" "file_role" NOT NULL,
	"storage_key" text NOT NULL,
	"bucket" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"container" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"page_count" integer,
	"scan_status" "scan_status" DEFAULT 'PENDING' NOT NULL,
	"scan_detail" text,
	"scanned_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "download_events" ADD CONSTRAINT "download_events_product_file_id_product_files_id_fk" FOREIGN KEY ("product_file_id") REFERENCES "public"."product_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_events" ADD CONSTRAINT "download_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_files" ADD CONSTRAINT "product_files_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_files" ADD CONSTRAINT "product_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "download_events_file_idx" ON "download_events" USING btree ("product_file_id","created_at");--> statement-breakpoint
CREATE INDEX "download_events_user_idx" ON "download_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_files_storage_key_unique" ON "product_files" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "product_files_role_unique" ON "product_files" USING btree ("product_id","role");--> statement-breakpoint
CREATE INDEX "product_files_product_idx" ON "product_files" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_files_scan_idx" ON "product_files" USING btree ("scan_status");