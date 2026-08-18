DROP INDEX "comments_siteId_idx";--> statement-breakpoint
CREATE INDEX "comments_siteId_idx" ON "comments" ("siteId","createdAt");