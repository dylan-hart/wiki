ALTER TABLE "pages" DROP COLUMN "ratingCount";--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "ratingCount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ALTER COLUMN "classification" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "pageEditSubmissions" DROP CONSTRAINT "pageEditSubmissions_authorId_users_id_fkey", ADD CONSTRAINT "pageEditSubmissions_authorId_users_id_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE;