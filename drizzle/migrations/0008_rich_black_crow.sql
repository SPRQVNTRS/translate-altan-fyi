CREATE TABLE "enrichment_votes" (
	"enrichment_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrichment_votes_enrichment_id_account_id_pk" PRIMARY KEY("enrichment_id","account_id"),
	CONSTRAINT "enrichment_votes_value_check" CHECK (value in (-1, 1))
);
--> statement-breakpoint
CREATE TABLE "reenrichment_log" (
	"headword_id" uuid NOT NULL,
	"from_language_code" text NOT NULL,
	"to_language_code" text NOT NULL,
	"last_queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reenrichment_log_headword_id_from_language_code_to_language_code_pk" PRIMARY KEY("headword_id","from_language_code","to_language_code")
);
--> statement-breakpoint
CREATE TABLE "abuse_counters" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "abuse_counters_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "abuse_rejections" (
	"day" date NOT NULL,
	"reason" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "abuse_rejections_day_reason_pk" PRIMARY KEY("day","reason"),
	CONSTRAINT "abuse_rejections_reason_check" CHECK (reason in ('rate-limited', 'budget'))
);
--> statement-breakpoint
CREATE TABLE "alert_log" (
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_log_day_kind_pk" PRIMARY KEY("day","kind"),
	CONSTRAINT "alert_log_kind_check" CHECK (kind in ('budget-warning', 'budget-cap'))
);
--> statement-breakpoint
CREATE TABLE "daily_budget" (
	"day" date PRIMARY KEY NOT NULL,
	"reserved_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"spent_usd" numeric(12, 6) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enrichments" ADD COLUMN "flagged_for_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "enrichment_votes" ADD CONSTRAINT "enrichment_votes_enrichment_id_enrichments_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reenrichment_log" ADD CONSTRAINT "reenrichment_log_headword_id_headwords_id_fk" FOREIGN KEY ("headword_id") REFERENCES "public"."headwords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reenrichment_log" ADD CONSTRAINT "reenrichment_log_from_language_code_languages_code_fk" FOREIGN KEY ("from_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reenrichment_log" ADD CONSTRAINT "reenrichment_log_to_language_code_languages_code_fk" FOREIGN KEY ("to_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrichment_votes_account_idx" ON "enrichment_votes" USING btree ("account_id");