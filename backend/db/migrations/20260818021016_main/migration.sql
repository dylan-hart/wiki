ALTER TABLE "hooks" ADD COLUMN "siteId" uuid;--> statement-breakpoint
CREATE INDEX "hooks_siteId_idx" ON "hooks" ("siteId");--> statement-breakpoint
ALTER TABLE "hooks" ADD CONSTRAINT "hooks_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");