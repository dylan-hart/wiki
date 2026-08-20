CREATE TABLE "pageEditSubmissionApprovals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"submissionId" uuid NOT NULL,
	"reviewerId" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvalRules" ADD COLUMN "minApprovals" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "pageEditSubmissionApprovals_submissionId_idx" ON "pageEditSubmissionApprovals" ("submissionId");--> statement-breakpoint
CREATE UNIQUE INDEX "pageEditSubmissionApprovals_submission_reviewer_idx" ON "pageEditSubmissionApprovals" ("submissionId","reviewerId");--> statement-breakpoint
ALTER TABLE "pageEditSubmissionApprovals" ADD CONSTRAINT "pageEditSubmissionApprovals_dRAFOzuOik4S_fkey" FOREIGN KEY ("submissionId") REFERENCES "pageEditSubmissions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pageEditSubmissionApprovals" ADD CONSTRAINT "pageEditSubmissionApprovals_reviewerId_users_id_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE CASCADE;