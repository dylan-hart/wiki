CREATE INDEX "jobHistory_active_idx" ON "jobHistory" ("startedAt") WHERE "state" = 'active';
