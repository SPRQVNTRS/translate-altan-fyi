CREATE TABLE "example_headwords" (
	"example_id" uuid NOT NULL,
	"headword_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "example_headwords_pkey" PRIMARY KEY("example_id","headword_id")
);
--> statement-breakpoint
ALTER TABLE "headwords" DROP CONSTRAINT "headwords_language_lemma_pos_unique";--> statement-breakpoint
ALTER TABLE "examples" DROP CONSTRAINT "examples_attachment_check";--> statement-breakpoint
ALTER TABLE "senses" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "example_headwords" ADD CONSTRAINT "example_headwords_example_id_examples_id_fk" FOREIGN KEY ("example_id") REFERENCES "public"."examples"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "example_headwords" ADD CONSTRAINT "example_headwords_headword_id_headwords_id_fk" FOREIGN KEY ("headword_id") REFERENCES "public"."headwords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "example_headwords_headword_id_idx" ON "example_headwords" USING btree ("headword_id");--> statement-breakpoint
ALTER TABLE "headwords" ADD CONSTRAINT "headwords_language_lemma_pos_unique" UNIQUE NULLS NOT DISTINCT("language_code","lemma","pos");--> statement-breakpoint
ALTER TABLE "senses" ADD CONSTRAINT "senses_source_external_id_unique" UNIQUE("source_id","external_id");