CREATE TYPE "public"."audit_action" AS ENUM('USER_CREATED', 'USER_UPDATED', 'USER_DISABLED', 'USER_ENABLED', 'USER_ROLE_CHANGED', 'USER_PASSWORD_CHANGED', 'USER_TWO_FACTOR_ENABLED', 'USER_TWO_FACTOR_DISABLED', 'LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'LOGIN_LOCKED_OUT', 'LOGOUT', 'SESSION_REVOKED', 'CONTRIBUTOR_CREATED', 'CONTRIBUTOR_UPDATED', 'CONTRIBUTOR_ACTIVATED', 'CONTRIBUTOR_DEACTIVATED', 'CONTRIBUTOR_DRAFT_RIGHTS_CHANGED', 'PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_PUBLISHED', 'PRODUCT_UNPUBLISHED', 'PRODUCT_DELETED', 'PRICE_CHANGED', 'COMMISSION_CHANGED', 'PAYMENT_METHOD_CHANGED', 'PAYMENT_APPROVED', 'PAYMENT_REJECTED', 'REFUND_ISSUED', 'SETTLEMENT_GENERATED', 'SETTLEMENT_APPROVED', 'SETTLEMENT_PAID', 'SETTINGS_CHANGED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('OWNER', 'ADMIN', 'CONTRIBUTOR', 'CUSTOMER');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'DISABLED', 'PENDING');--> statement-breakpoint
CREATE TABLE "contributors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"public_slug" text NOT NULL,
	"settlement_code" text NOT NULL,
	"display_name" text NOT NULL,
	"specialization" text,
	"bio" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"can_submit_drafts" boolean DEFAULT false NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"two_factor_verified_at" timestamp with time zone,
	"ip_hash" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'CUSTOMER' NOT NULL,
	"status" "user_status" DEFAULT 'PENDING' NOT NULL,
	"display_name" text NOT NULL,
	"locale" text DEFAULT 'ar' NOT NULL,
	"country_code" text,
	"email_verified_at" timestamp with time zone,
	"totp_secret_encrypted" text,
	"totp_enabled_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"actor_role" "user_role",
	"action" "audit_action" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip_hash" text,
	"user_agent" text,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contributors" ADD CONSTRAINT "contributors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributors" ADD CONSTRAINT "contributors_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contributors_user_unique" ON "contributors" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contributors_slug_unique" ON "contributors" USING btree ("public_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "contributors_settlement_code_unique" ON "contributors" USING btree ("settlement_code");--> statement-breakpoint
CREATE INDEX "contributors_active_idx" ON "contributors" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_grants_unique" ON "permission_grants" USING btree ("user_id","permission");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_status_idx" ON "users" USING btree ("role","status");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_correlation_idx" ON "audit_logs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "rate_limit_window_idx" ON "rate_limit_buckets" USING btree ("window_started_at");