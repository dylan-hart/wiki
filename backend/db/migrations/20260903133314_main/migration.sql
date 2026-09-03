ALTER TABLE "pageDrafts" ADD COLUMN "authorId" uuid;--> statement-breakpoint
ALTER TABLE "pageDrafts" ADD COLUMN "authorName" varchar(255);--> statement-breakpoint
ALTER TABLE "pageDrafts" ADD CONSTRAINT "pageDrafts_authorId_users_id_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL;