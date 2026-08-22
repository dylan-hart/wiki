CREATE TABLE "glossaryVersions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"siteId" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"termCount" integer NOT NULL,
	"actorId" uuid,
	"actorName" varchar(255) DEFAULT '' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "glossaryVersions_siteId_idx" ON "glossaryVersions" ("siteId");--> statement-breakpoint
CREATE INDEX "glossaryVersions_siteId_createdAt_idx" ON "glossaryVersions" ("siteId","createdAt");--> statement-breakpoint
ALTER TABLE "glossaryVersions" ADD CONSTRAINT "glossaryVersions_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "glossaryVersions" ADD CONSTRAINT "glossaryVersions_actorId_users_id_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL;