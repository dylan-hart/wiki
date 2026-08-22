CREATE TABLE "glossaryTerms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"term" varchar(255) NOT NULL,
	"definition" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"siteId" uuid NOT NULL,
	"pageId" uuid
);
--> statement-breakpoint
CREATE INDEX "glossaryTerms_siteId_idx" ON "glossaryTerms" ("siteId");--> statement-breakpoint
CREATE UNIQUE INDEX "glossaryTerms_composite_idx" ON "glossaryTerms" ("siteId",lower("term"));--> statement-breakpoint
ALTER TABLE "glossaryTerms" ADD CONSTRAINT "glossaryTerms_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "glossaryTerms" ADD CONSTRAINT "glossaryTerms_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE SET NULL;