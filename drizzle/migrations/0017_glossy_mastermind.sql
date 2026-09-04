ALTER TABLE "enrichment_votes" DROP CONSTRAINT "enrichment_votes_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "sync_blobs" DROP CONSTRAINT "sync_blobs_account_id_accounts_id_fk";
--> statement-breakpoint
DROP INDEX "sync_blobs_account_version_idx";--> statement-breakpoint
DROP INDEX "sync_blobs_account_idx";--> statement-breakpoint
ALTER TABLE "sync_blobs" ADD COLUMN "user_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_blobs" ADD COLUMN "payload" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "enrichment_votes" ADD CONSTRAINT "enrichment_votes_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_blobs" ADD CONSTRAINT "sync_blobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_blobs_user_idx" ON "sync_blobs" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "sync_blobs" DROP COLUMN "account_id";--> statement-breakpoint
ALTER TABLE "sync_blobs" DROP COLUMN "envelope_version";--> statement-breakpoint
ALTER TABLE "sync_blobs" DROP COLUMN "ciphertext";