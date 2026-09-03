CREATE TABLE "pageDrafts" (
	"pageId" uuid PRIMARY KEY,
	"content" text NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" varchar(255) NOT NULL,
	"icon" varchar(255) NOT NULL,
	"authorId" uuid,
	"authorName" varchar(255),
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pageDrafts" ADD CONSTRAINT "pageDrafts_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pageDrafts" ADD CONSTRAINT "pageDrafts_authorId_users_id_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL;