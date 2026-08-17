ALTER TABLE "pageWatchEvents" ADD COLUMN "changedFields" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "pageWatchEvents" ADD COLUMN "actorId" uuid;--> statement-breakpoint
ALTER TABLE "pageWatchEvents" ADD CONSTRAINT "pageWatchEvents_actorId_users_id_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL;