ALTER TABLE "storage" ADD COLUMN "syncMode" varchar(32) DEFAULT 'push' NOT NULL;--> statement-breakpoint
ALTER TABLE "storage" ADD COLUMN "scheduleOverride" varchar(32);