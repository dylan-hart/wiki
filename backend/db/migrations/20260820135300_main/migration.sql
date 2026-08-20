ALTER TABLE "apiKeys" ADD COLUMN "userId" uuid;--> statement-breakpoint
CREATE INDEX "apiKeys_userId_idx" ON "apiKeys" ("userId");--> statement-breakpoint
ALTER TABLE "apiKeys" ADD CONSTRAINT "apiKeys_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;