CREATE TABLE "migrationRecords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"siteId" uuid NOT NULL,
	"sourceSystem" varchar(255) NOT NULL,
	"sourceTable" varchar(255) NOT NULL,
	"sourceId" varchar(255) NOT NULL,
	"destTable" varchar(255) NOT NULL,
	"destId" uuid NOT NULL,
	"importedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "migrationRecords_source_idx" ON "migrationRecords" ("siteId","sourceSystem","sourceTable","sourceId");--> statement-breakpoint
CREATE INDEX "migrationRecords_dest_idx" ON "migrationRecords" ("destTable","destId");--> statement-breakpoint
ALTER TABLE "migrationRecords" ADD CONSTRAINT "migrationRecords_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");