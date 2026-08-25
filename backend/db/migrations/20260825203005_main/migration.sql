ALTER TABLE "siteAssets" ADD COLUMN "hash" varchar(255);--> statement-breakpoint
ALTER TABLE "userAvatars" ADD COLUMN "hash" varchar(255);--> statement-breakpoint
UPDATE "siteAssets" SET "hash" = encode(digest("data", 'sha1'), 'hex') WHERE "hash" IS NULL;--> statement-breakpoint
UPDATE "userAvatars" SET "hash" = encode(digest("data", 'sha1'), 'hex') WHERE "hash" IS NULL;--> statement-breakpoint
ALTER TABLE "siteAssets" ALTER COLUMN "hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "userAvatars" ALTER COLUMN "hash" SET NOT NULL;
