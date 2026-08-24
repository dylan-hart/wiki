CREATE TABLE "pageviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"siteId" uuid NOT NULL,
	"pageId" uuid NOT NULL,
	"clientType" varchar(16) NOT NULL,
	"visitorHash" text NOT NULL,
	"viewedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pageviews_pageId_viewedAt_idx" ON "pageviews" ("pageId","viewedAt");--> statement-breakpoint
CREATE INDEX "pageviews_viewedAt_idx" ON "pageviews" ("viewedAt");--> statement-breakpoint
ALTER TABLE "pageviews" ADD CONSTRAINT "pageviews_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "pageviews" ADD CONSTRAINT "pageviews_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE;