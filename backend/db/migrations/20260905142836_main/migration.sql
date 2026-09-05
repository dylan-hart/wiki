ALTER TABLE "glossaryTerms" ADD COLUMN "isAcronym" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "glossaryTerms" ALTER COLUMN "aliases" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "glossaryTerms" ALTER COLUMN "aliases" SET DATA TYPE jsonb USING to_jsonb("aliases");--> statement-breakpoint
ALTER TABLE "glossaryTerms" ALTER COLUMN "aliases" SET DEFAULT '[]';