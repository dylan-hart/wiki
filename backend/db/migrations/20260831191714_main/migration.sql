CREATE TYPE "pageEditSubmissionStatus" AS ENUM('open', 'approved', 'declined');--> statement-breakpoint
ALTER TABLE "pageEditSubmissions" ADD COLUMN "status" "pageEditSubmissionStatus" DEFAULT 'open'::"pageEditSubmissionStatus" NOT NULL;--> statement-breakpoint
ALTER TABLE "pageEditSubmissions" ADD COLUMN "resolvedReason" text;--> statement-breakpoint
ALTER TABLE "pageEditSubmissions" ADD COLUMN "resolvedBy" uuid;--> statement-breakpoint
ALTER TABLE "pageEditSubmissions" ADD CONSTRAINT "pageEditSubmissions_resolvedBy_users_id_fkey" FOREIGN KEY ("resolvedBy") REFERENCES "users"("id") ON DELETE SET NULL;