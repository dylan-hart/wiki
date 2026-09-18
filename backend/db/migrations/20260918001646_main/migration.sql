CREATE TABLE "tfaKnownDevices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"userId" uuid NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"ip" varchar(255),
	"userAgent" text,
	"firstSeenAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastSeenAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "scripts" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tfaKnownDevices_userId_fingerprint_idx" ON "tfaKnownDevices" ("userId","fingerprint");--> statement-breakpoint
ALTER TABLE "tfaKnownDevices" ADD CONSTRAINT "tfaKnownDevices_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;