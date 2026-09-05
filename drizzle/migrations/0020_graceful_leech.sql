CREATE TABLE "translation_votes" (
	"translation_id" uuid NOT NULL,
	"account_id" integer NOT NULL,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translation_votes_translation_id_account_id_pk" PRIMARY KEY("translation_id","account_id"),
	CONSTRAINT "translation_votes_value_check" CHECK (value in (-1, 1))
);
--> statement-breakpoint
ALTER TABLE "translation_votes" ADD CONSTRAINT "translation_votes_translation_id_translations_id_fk" FOREIGN KEY ("translation_id") REFERENCES "public"."translations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_votes" ADD CONSTRAINT "translation_votes_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "translation_votes_account_idx" ON "translation_votes" USING btree ("account_id");