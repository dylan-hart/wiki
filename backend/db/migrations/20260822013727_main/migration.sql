CREATE TABLE "auditLog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"event" varchar(64) NOT NULL,
	"actorId" uuid,
	"actorName" varchar(255) DEFAULT '' NOT NULL,
	"actorIp" varchar(64) DEFAULT '' NOT NULL,
	"targetType" varchar(32) DEFAULT '' NOT NULL,
	"targetId" varchar(255) DEFAULT '' NOT NULL,
	"targetLabel" varchar(255) DEFAULT '' NOT NULL,
	"detail" jsonb DEFAULT '{}' NOT NULL,
	"siteId" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auditLog_createdAt_idx" ON "auditLog" ("createdAt");--> statement-breakpoint
CREATE INDEX "auditLog_actorId_idx" ON "auditLog" ("actorId","createdAt");--> statement-breakpoint
CREATE INDEX "auditLog_event_idx" ON "auditLog" ("event","createdAt");--> statement-breakpoint
CREATE INDEX "auditLog_siteId_idx" ON "auditLog" ("siteId","createdAt");--> statement-breakpoint
ALTER TABLE "auditLog" ADD CONSTRAINT "auditLog_actorId_users_id_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "auditLog" ADD CONSTRAINT "auditLog_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL;