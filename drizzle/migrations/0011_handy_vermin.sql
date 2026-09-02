ALTER TABLE "enrichment_votes" DROP CONSTRAINT "enrichment_votes_enrichment_id_pk";--> statement-breakpoint
ALTER TABLE "enrichment_votes" ADD CONSTRAINT "enrichment_votes_enrichment_id_account_id_pk" PRIMARY KEY("enrichment_id","account_id");--> statement-breakpoint
CREATE INDEX "enrichment_votes_account_idx" ON "enrichment_votes" USING btree ("account_id");