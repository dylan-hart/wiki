CREATE TYPE "syncContentType" AS ENUM('page', 'asset');--> statement-breakpoint
CREATE TYPE "syncDirection" AS ENUM('push', 'pull');--> statement-breakpoint
CREATE TABLE "contentSyncState" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"contentType" "syncContentType" NOT NULL,
	"contentId" uuid NOT NULL,
	"targetId" uuid NOT NULL,
	"lastDirection" "syncDirection",
	"targetRef" jsonb,
	"lastSyncedAt" timestamp,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "storageInfo";--> statement-breakpoint
CREATE UNIQUE INDEX "contentSyncState_target_content_idx" ON "contentSyncState" ("targetId","contentType","contentId");--> statement-breakpoint
CREATE INDEX "contentSyncState_content_idx" ON "contentSyncState" ("contentType","contentId");--> statement-breakpoint
ALTER TABLE "contentSyncState" ADD CONSTRAINT "contentSyncState_targetId_storage_id_fkey" FOREIGN KEY ("targetId") REFERENCES "storage"("id") ON DELETE CASCADE;