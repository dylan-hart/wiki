ALTER TABLE "apiKeys" DROP CONSTRAINT "apiKeys_maxClassification_classificationLevels_id_fkey";--> statement-breakpoint
ALTER TABLE "apiKeys" ADD COLUMN "allowedClassifications" jsonb DEFAULT 'null';--> statement-breakpoint
ALTER TABLE "apiKeys" DROP COLUMN "maxClassification";