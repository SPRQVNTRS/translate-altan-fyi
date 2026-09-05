CREATE TABLE "translation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"headword_id" uuid NOT NULL,
	"from_language_code" text NOT NULL,
	"to_language_code" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"output" jsonb,
	"written" jsonb,
	"capped" boolean DEFAULT false NOT NULL,
	"error" text,
	"cost_usd" numeric(10, 6),
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"retracted_at" timestamp with time zone,
	CONSTRAINT "translation_runs_status_check" CHECK (status in ('pending', 'ok', 'failed', 'budget'))
);
--> statement-breakpoint
ALTER TABLE "translation_runs" ADD CONSTRAINT "translation_runs_headword_id_headwords_id_fk" FOREIGN KEY ("headword_id") REFERENCES "public"."headwords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_runs" ADD CONSTRAINT "translation_runs_from_language_code_languages_code_fk" FOREIGN KEY ("from_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_runs" ADD CONSTRAINT "translation_runs_to_language_code_languages_code_fk" FOREIGN KEY ("to_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "translation_runs_latest_idx" ON "translation_runs" USING btree ("headword_id","from_language_code","to_language_code","created_at" DESC NULLS LAST);