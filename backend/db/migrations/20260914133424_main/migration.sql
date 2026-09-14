ALTER TABLE "pageWatchEvents" ALTER COLUMN "pageId" DROP NOT NULL;--> statement-breakpoint
-- OpenProject #3203: purge pre-existing orphans before the FK below can apply cleanly. Every row
-- written under the old, unfixed timing (the deferred `notifyPageWatchers` job inserting a `deleted`
-- event's rows *after* `deletePage`/`deleteOrphaned` had already deleted the `pages` row) points at a
-- page id that no longer exists; the fix below stops new ones from being written, but any that already
-- exist here would fail the `ADD CONSTRAINT` outright. Nulling `pageId` on them is exactly the state
-- the new `set null` FK would put a currently-valid row into the next time its own page is deleted, so
-- this is not data loss beyond what the FK itself will do going forward -- `pageTitle`/`pagePath`/
-- `pageLocale`, captured at write time for precisely this reason, are untouched.
UPDATE "pageWatchEvents" SET "pageId" = NULL WHERE "pageId" IS NOT NULL AND "pageId" NOT IN (SELECT "id" FROM "pages");--> statement-breakpoint
ALTER TABLE "pageWatchEvents" ADD CONSTRAINT "pageWatchEvents_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE SET NULL;
