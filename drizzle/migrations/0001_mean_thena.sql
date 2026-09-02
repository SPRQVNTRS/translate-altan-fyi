-- Hand-appended to the drizzle-kit output, in this order and for these reasons:
--   1. pg_trgm and unaccent power the forgiving search in this milestone.
--      drizzle-kit does not emit CREATE EXTENSION, so it lives here.
--   2. The GIN trigram index on headwords.lemma_normalized is what makes a
--      misspelled query cheap. It needs pg_trgm, hence the order.
--   3. The four v1 languages are reference data, not user data, so the
--      migration seeds them. ON CONFLICT DO NOTHING keeps a re-run safe.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE TABLE "entry_aliases" (
	"retired_id" uuid PRIMARY KEY NOT NULL,
	"replacement_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_aliases_entity_check" CHECK ("entry_aliases"."entity" IN ('headword', 'sense', 'translation'))
);
--> statement-breakpoint
CREATE TABLE "examples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sense_id" uuid,
	"headword_id" uuid,
	"language_code" text NOT NULL,
	"text" text NOT NULL,
	"translation_text" text,
	"translation_language_code" text,
	"source_id" uuid NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "examples_attachment_check" CHECK ("examples"."sense_id" IS NOT NULL OR "examples"."headword_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "headword_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_headword_id" uuid NOT NULL,
	"to_headword_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" text DEFAULT 'panlex-fallback' NOT NULL,
	"score" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "headword_links_from_to_source_unique" UNIQUE("from_headword_id","to_headword_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "headwords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"language_code" text NOT NULL,
	"lemma" text NOT NULL,
	"lemma_normalized" text NOT NULL,
	"pos" text,
	"source_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "headwords_language_lemma_pos_unique" UNIQUE("language_code","lemma","pos")
);
--> statement-breakpoint
CREATE TABLE "languages" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sense_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sense_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"gloss_language_code" text NOT NULL,
	"gloss" text NOT NULL,
	"notes" text,
	"source_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sense_versions_sense_version_unique" UNIQUE("sense_id","version")
);
--> statement-breakpoint
CREATE TABLE "senses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"headword_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"licence" text NOT NULL,
	"attribution" text NOT NULL,
	"imported_at" timestamp with time zone,
	"version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_sense_id" uuid NOT NULL,
	"to_sense_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translations_from_to_source_unique" UNIQUE("from_sense_id","to_sense_id","source_id"),
	CONSTRAINT "translations_distinct_senses_check" CHECK ("translations"."from_sense_id" <> "translations"."to_sense_id")
);
--> statement-breakpoint
ALTER TABLE "examples" ADD CONSTRAINT "examples_sense_id_senses_id_fk" FOREIGN KEY ("sense_id") REFERENCES "public"."senses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examples" ADD CONSTRAINT "examples_headword_id_headwords_id_fk" FOREIGN KEY ("headword_id") REFERENCES "public"."headwords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examples" ADD CONSTRAINT "examples_language_code_languages_code_fk" FOREIGN KEY ("language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examples" ADD CONSTRAINT "examples_translation_language_code_languages_code_fk" FOREIGN KEY ("translation_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examples" ADD CONSTRAINT "examples_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headword_links" ADD CONSTRAINT "headword_links_from_headword_id_headwords_id_fk" FOREIGN KEY ("from_headword_id") REFERENCES "public"."headwords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headword_links" ADD CONSTRAINT "headword_links_to_headword_id_headwords_id_fk" FOREIGN KEY ("to_headword_id") REFERENCES "public"."headwords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headword_links" ADD CONSTRAINT "headword_links_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headwords" ADD CONSTRAINT "headwords_language_code_languages_code_fk" FOREIGN KEY ("language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headwords" ADD CONSTRAINT "headwords_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sense_versions" ADD CONSTRAINT "sense_versions_sense_id_senses_id_fk" FOREIGN KEY ("sense_id") REFERENCES "public"."senses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sense_versions" ADD CONSTRAINT "sense_versions_gloss_language_code_languages_code_fk" FOREIGN KEY ("gloss_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sense_versions" ADD CONSTRAINT "sense_versions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "senses" ADD CONSTRAINT "senses_headword_id_headwords_id_fk" FOREIGN KEY ("headword_id") REFERENCES "public"."headwords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "senses" ADD CONSTRAINT "senses_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_from_sense_id_senses_id_fk" FOREIGN KEY ("from_sense_id") REFERENCES "public"."senses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_to_sense_id_senses_id_fk" FOREIGN KEY ("to_sense_id") REFERENCES "public"."senses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "examples_sense_id_idx" ON "examples" USING btree ("sense_id");--> statement-breakpoint
CREATE INDEX "examples_headword_id_idx" ON "examples" USING btree ("headword_id");--> statement-breakpoint
CREATE INDEX "examples_language_code_idx" ON "examples" USING btree ("language_code");--> statement-breakpoint
CREATE INDEX "examples_translation_language_code_idx" ON "examples" USING btree ("translation_language_code");--> statement-breakpoint
CREATE INDEX "examples_source_id_idx" ON "examples" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "headword_links_from_headword_id_idx" ON "headword_links" USING btree ("from_headword_id");--> statement-breakpoint
CREATE INDEX "headword_links_to_headword_id_idx" ON "headword_links" USING btree ("to_headword_id");--> statement-breakpoint
CREATE INDEX "headword_links_source_id_idx" ON "headword_links" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "headwords_language_code_idx" ON "headwords" USING btree ("language_code");--> statement-breakpoint
CREATE INDEX "headwords_source_id_idx" ON "headwords" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "sense_versions_sense_id_idx" ON "sense_versions" USING btree ("sense_id");--> statement-breakpoint
CREATE INDEX "sense_versions_gloss_language_code_idx" ON "sense_versions" USING btree ("gloss_language_code");--> statement-breakpoint
CREATE INDEX "sense_versions_source_id_idx" ON "sense_versions" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "senses_headword_id_idx" ON "senses" USING btree ("headword_id");--> statement-breakpoint
CREATE INDEX "senses_source_id_idx" ON "senses" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "translations_from_sense_id_idx" ON "translations" USING btree ("from_sense_id");--> statement-breakpoint
CREATE INDEX "translations_to_sense_id_idx" ON "translations" USING btree ("to_sense_id");--> statement-breakpoint
CREATE INDEX "translations_source_id_idx" ON "translations" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "headwords_lemma_normalized_trgm_idx" ON "headwords" USING gin ("lemma_normalized" gin_trgm_ops);--> statement-breakpoint
INSERT INTO "languages" ("code", "name") VALUES
	('en', 'English'),
	('de', 'German'),
	('tr', 'Turkish'),
	('es', 'Spanish')
ON CONFLICT ("code") DO NOTHING;
