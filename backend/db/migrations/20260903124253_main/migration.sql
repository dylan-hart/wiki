CREATE TABLE "pageDrafts" (
	"pageId" uuid PRIMARY KEY,
	"siteId" uuid NOT NULL,
	"state" bytea NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pageDrafts_updatedAt_idx" ON "pageDrafts" ("updatedAt");--> statement-breakpoint
ALTER TABLE "pageDrafts" ADD CONSTRAINT "pageDrafts_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pageDrafts" ADD CONSTRAINT "pageDrafts_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");