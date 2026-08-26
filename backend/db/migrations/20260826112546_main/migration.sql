ALTER TABLE "authentication" ADD COLUMN "selfRegistration" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "authentication" ADD COLUMN "autoProvisioning" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "authentication" DROP COLUMN "registration";