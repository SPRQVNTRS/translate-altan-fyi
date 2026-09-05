CREATE TABLE "phrase_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_language_code" text NOT NULL,
	"to_language_code" text NOT NULL,
	"source_text" text NOT NULL,
	"source_normalized" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"translation_text" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"cost_usd" numeric(10, 6),
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "phrase_translations_status_check" CHECK (status in ('pending', 'ok', 'failed', 'budget'))
);
--> statement-breakpoint
ALTER TABLE "phrase_translations" ADD CONSTRAINT "phrase_translations_from_language_code_languages_code_fk" FOREIGN KEY ("from_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phrase_translations" ADD CONSTRAINT "phrase_translations_to_language_code_languages_code_fk" FOREIGN KEY ("to_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phrase_translations_latest_idx" ON "phrase_translations" USING btree ("from_language_code","to_language_code","source_normalized","created_at" DESC NULLS LAST);