CREATE TABLE "eventSubscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"userId" uuid NOT NULL,
	"event" varchar(64) NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "eventSubscriptions_event_idx" ON "eventSubscriptions" ("event");--> statement-breakpoint
CREATE UNIQUE INDEX "eventSubscriptions_user_event_idx" ON "eventSubscriptions" ("userId","event");--> statement-breakpoint
ALTER TABLE "eventSubscriptions" ADD CONSTRAINT "eventSubscriptions_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;