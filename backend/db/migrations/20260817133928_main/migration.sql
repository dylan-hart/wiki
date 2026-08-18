CREATE TABLE "blockCode" (
	"blockId" uuid PRIMARY KEY,
	"code" bytea NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "props" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "template" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "elementTag" varchar(255) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "blockCode" ADD CONSTRAINT "blockCode_blockId_blocks_id_fkey" FOREIGN KEY ("blockId") REFERENCES "blocks"("id") ON DELETE CASCADE;