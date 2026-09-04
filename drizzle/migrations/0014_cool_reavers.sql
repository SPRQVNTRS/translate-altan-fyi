ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_created_by_users_id_fk";
--> statement-breakpoint
DROP INDEX "api_keys_org_idx";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "is_superadmin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "created_by";