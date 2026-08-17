ALTER TABLE "pageWatching" ADD COLUMN "notifyMode" varchar(16);--> statement-breakpoint
ALTER TABLE "pageWatching" ADD COLUMN "notifyOnEdited" boolean;--> statement-breakpoint
ALTER TABLE "pageWatching" ADD COLUMN "notifyOnMoved" boolean;--> statement-breakpoint
ALTER TABLE "pageWatching" ADD COLUMN "notifyOnDeleted" boolean;