CREATE TYPE "public"."notification_type" AS ENUM('PRODUCT_SUBMITTED', 'PRODUCT_APPROVED', 'PRODUCT_REVISION_REQUESTED', 'PRODUCT_PUBLISHED', 'PRODUCT_UNPUBLISHED', 'PRODUCT_PRICE_CHANGED', 'COMMISSION_CHANGED', 'MONTHLY_STATEMENT_AVAILABLE', 'SETTLEMENT_APPROVED', 'SETTLEMENT_PAID', 'ORDER_PAID', 'PAYMENT_REJECTED');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id","read_at");