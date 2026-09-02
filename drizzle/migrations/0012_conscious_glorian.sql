CREATE TABLE "sync_blobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"blob_version" integer NOT NULL,
	"envelope_version" integer NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_blobs" ADD CONSTRAINT "sync_blobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_blobs_account_version_idx" ON "sync_blobs" USING btree ("account_id","blob_version");--> statement-breakpoint
CREATE INDEX "sync_blobs_account_idx" ON "sync_blobs" USING btree ("account_id");