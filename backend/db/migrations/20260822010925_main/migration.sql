CREATE TABLE "checklistExecutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"siteId" uuid NOT NULL,
	"pageId" uuid NOT NULL,
	"blockKey" varchar(255) NOT NULL,
	"itemCount" integer NOT NULL,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"startedBy" uuid,
	"completedAt" timestamp,
	"completedBy" uuid
);
--> statement-breakpoint
CREATE TABLE "checklistItemChecks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"executionId" uuid NOT NULL,
	"itemKey" varchar(255) NOT NULL,
	"checkedBy" uuid,
	"checkedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "checklistExecutions_pageId_blockKey_idx" ON "checklistExecutions" ("pageId","blockKey","startedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "checklistExecutions_active_idx" ON "checklistExecutions" ("pageId","blockKey") WHERE "completedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "checklistItemChecks_execution_item_idx" ON "checklistItemChecks" ("executionId","itemKey");--> statement-breakpoint
CREATE INDEX "checklistItemChecks_executionId_idx" ON "checklistItemChecks" ("executionId","checkedAt");--> statement-breakpoint
ALTER TABLE "checklistExecutions" ADD CONSTRAINT "checklistExecutions_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "checklistExecutions" ADD CONSTRAINT "checklistExecutions_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "checklistExecutions" ADD CONSTRAINT "checklistExecutions_startedBy_users_id_fkey" FOREIGN KEY ("startedBy") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "checklistExecutions" ADD CONSTRAINT "checklistExecutions_completedBy_users_id_fkey" FOREIGN KEY ("completedBy") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "checklistItemChecks" ADD CONSTRAINT "checklistItemChecks_executionId_checklistExecutions_id_fkey" FOREIGN KEY ("executionId") REFERENCES "checklistExecutions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "checklistItemChecks" ADD CONSTRAINT "checklistItemChecks_checkedBy_users_id_fkey" FOREIGN KEY ("checkedBy") REFERENCES "users"("id") ON DELETE SET NULL;