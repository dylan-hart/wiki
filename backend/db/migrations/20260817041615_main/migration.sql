CREATE TABLE "commentProviders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"module" varchar(255) NOT NULL,
	"isEnabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"siteId" uuid NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commentProviders_composite_idx" ON "commentProviders" ("siteId","module");--> statement-breakpoint
ALTER TABLE "commentProviders" ADD CONSTRAINT "commentProviders_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");