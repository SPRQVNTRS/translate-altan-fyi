CREATE TABLE "invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"minted_by_account_id" integer,
	"redeemed_by_account_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"redeemed_at" timestamp,
	"expires_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_minted_by_account_id_accounts_id_fk" FOREIGN KEY ("minted_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_redeemed_by_account_id_accounts_id_fk" FOREIGN KEY ("redeemed_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_hash_idx" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invites_redeemed_at_idx" ON "invites" USING btree ("redeemed_at");