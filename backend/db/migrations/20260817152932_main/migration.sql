ALTER TABLE "navigation" ADD COLUMN "locale" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "navigation_siteId_locale_idx" ON "navigation" ("siteId","locale");