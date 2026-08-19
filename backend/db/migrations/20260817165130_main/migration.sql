ALTER TABLE "pageWatchEvents" ADD COLUMN "pageTitle" text NOT NULL;--> statement-breakpoint
ALTER TABLE "pageWatchEvents" ADD COLUMN "pagePath" text NOT NULL;--> statement-breakpoint
ALTER TABLE "pageWatchEvents" ADD COLUMN "notifyMode" varchar(16) NOT NULL;--> statement-breakpoint
DROP INDEX "pageWatchEvents_pending_idx";--> statement-breakpoint
CREATE INDEX "pageWatchEvents_pending_idx" ON "pageWatchEvents" ("userId","notifyMode","createdAt") WHERE "deliveredAt" IS NULL;