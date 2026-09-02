CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "app_settings_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"actor_user_id" text,
	"actor_email" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "app_settings_audit_key_at_idx" ON "app_settings_audit" USING btree ("key","at" DESC NULLS LAST);--> statement-breakpoint
-- The active model, seeded here rather than by application code, for the same
-- reason the four `languages` rows are seeded in 0001: the app must be able to
-- boot against an empty database and still have an answer for "which model".
-- `updated_by` stays NULL, because a migration has no actor. A superadmin
-- switch overwrites this row and writes an audit entry beside it.
INSERT INTO "app_settings" ("key", "value", "updated_by") VALUES
	('llm.active', '{"provider":"gemini","model":"google/gemini-3.7-flash","options":{}}'::jsonb, NULL)
ON CONFLICT ("key") DO NOTHING;
