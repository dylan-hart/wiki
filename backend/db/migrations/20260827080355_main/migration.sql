DROP INDEX "blocks_siteId_idx";--> statement-breakpoint
DELETE FROM "blocks" a USING "blocks" b WHERE a.id > b.id AND a."siteId" = b."siteId" AND a."block" = b."block";--> statement-breakpoint
CREATE UNIQUE INDEX "blocks_composite_idx" ON "blocks" ("siteId","block");