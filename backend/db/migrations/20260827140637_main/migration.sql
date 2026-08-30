CREATE TYPE "submissionStatus" AS ENUM('open', 'approved', 'declined');--> statement-breakpoint
ALTER TABLE "pageEditSubmissions" ADD COLUMN "status" "submissionStatus" DEFAULT 'open'::"submissionStatus" NOT NULL;--> statement-breakpoint
ALTER TABLE "pageEditSubmissions" ADD COLUMN "resolvedReason" text;--> statement-breakpoint
ALTER TABLE "pageEditSubmissions" ADD COLUMN "resolvedBy" uuid;--> statement-breakpoint
DROP INDEX "pageEditSubmissions_page_author_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "pageEditSubmissions_page_author_idx" ON "pageEditSubmissions" ("pageId","authorId") WHERE "authorId" IS NOT NULL AND "status" = 'open';--> statement-breakpoint
ALTER TABLE "pageEditSubmissions" ADD CONSTRAINT "pageEditSubmissions_resolvedBy_users_id_fkey" FOREIGN KEY ("resolvedBy") REFERENCES "users"("id") ON DELETE SET NULL;