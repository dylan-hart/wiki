CREATE TABLE "pageWatchEvents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"action" varchar(16) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"deliveredAt" timestamp,
	"pageId" uuid NOT NULL,
	"siteId" uuid NOT NULL,
	"userId" uuid NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pageWatchEvents_pending_idx" ON "pageWatchEvents" ("userId","createdAt") WHERE "deliveredAt" IS NULL;--> statement-breakpoint
CREATE INDEX "pageWatchEvents_pageId_idx" ON "pageWatchEvents" ("pageId");--> statement-breakpoint
ALTER TABLE "pageWatchEvents" ADD CONSTRAINT "pageWatchEvents_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "pageWatchEvents" ADD CONSTRAINT "pageWatchEvents_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;