CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"content" text NOT NULL,
	"render" text,
	"guestName" varchar(255),
	"guestEmail" varchar(255),
	"guestIp" varchar(45),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"pageId" uuid NOT NULL,
	"siteId" uuid NOT NULL,
	"authorId" uuid,
	"replyTo" uuid
);
--> statement-breakpoint
CREATE INDEX "comments_pageId_idx" ON "comments" ("pageId","createdAt");--> statement-breakpoint
CREATE INDEX "comments_siteId_idx" ON "comments" ("siteId","createdAt");--> statement-breakpoint
CREATE INDEX "comments_authorId_idx" ON "comments" ("authorId");--> statement-breakpoint
CREATE INDEX "comments_replyTo_idx" ON "comments" ("replyTo");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_authorId_users_id_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_replyTo_comments_id_fkey" FOREIGN KEY ("replyTo") REFERENCES "comments"("id") ON DELETE CASCADE;