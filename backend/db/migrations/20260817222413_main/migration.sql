ALTER TABLE "apiKeys" ADD COLUMN "siteId" uuid;--> statement-breakpoint
CREATE INDEX "apiKeys_siteId_idx" ON "apiKeys" ("siteId");--> statement-breakpoint
ALTER TABLE "apiKeys" ADD CONSTRAINT "apiKeys_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");