CREATE TABLE "classificationLevels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(255) NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Seed the three default levels at their fixed system ids (base.yml's `systemIds`), unconditionally
-- and on every database this migration runs against -- not just a fresh install. `pages.classification`
-- below is a NOT NULL column with a default pointing at `classificationPublicId`, so this insert has to
-- exist and be committed before that column (and its FK to this table) can be added, whether the
-- database already holds pages to backfill or is empty. `models/classificationLevels.ts#init()` is
-- guarded with `onConflictDoNothing` for the fresh-install path, where `core/config.ts#initDbValues()`
-- also calls it once settings are found empty -- these three rows already existing by then is a no-op
-- for it, not a conflict.
INSERT INTO "classificationLevels" ("id", "name", "sortOrder") VALUES
	('30000000-0000-4000-8000-000000000001', 'Public', 0),
	('30000000-0000-4000-8000-000000000002', 'Internal', 1),
	('30000000-0000-4000-8000-000000000003', 'Restricted', 2);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "classification" uuid DEFAULT '30000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
CREATE INDEX "pages_classification_idx" ON "pages" ("classification");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_classification_classificationLevels_id_fkey" FOREIGN KEY ("classification") REFERENCES "classificationLevels"("id");