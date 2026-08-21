UPDATE "tree" SET "folderPath" = '' WHERE "folderPath" IS NULL;--> statement-breakpoint
ALTER TABLE "tree" ALTER COLUMN "folderPath" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "tree" ALTER COLUMN "folderPath" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pages_siteId_locale_path_idx" ON "pages" ("siteId","locale","path");--> statement-breakpoint
CREATE INDEX "pages_siteId_locale_hash_idx" ON "pages" ("siteId","locale","hash");--> statement-breakpoint
CREATE UNIQUE INDEX "tree_composite_page_idx" ON "tree" ("siteId","locale","folderPath","fileName") WHERE "tree" = 'page';--> statement-breakpoint
CREATE UNIQUE INDEX "tree_composite_nonpage_idx" ON "tree" ("siteId","locale","folderPath","fileName") WHERE "tree" <> 'page';
