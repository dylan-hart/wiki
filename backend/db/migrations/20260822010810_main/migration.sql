CREATE TABLE "blockCredentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"siteId" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"secret" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "blockCredentials_siteId_idx" ON "blockCredentials" ("siteId");--> statement-breakpoint
ALTER TABLE "blockCredentials" ADD CONSTRAINT "blockCredentials_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");